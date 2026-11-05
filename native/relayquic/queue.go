package relayquic

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
)

// These are memory guards, not target buffering. Matching OutboundChannelMux's
// per-channel limits keeps an ordinary 1–8 MiB pull window below the bulk guard.
var queueByteLimits = [5]int{4 * 1024 * 1024, 32 * 1024 * 1024, 64 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 * 1024}

const maxQueueFrames = 16384

var ErrQueueCapacity = errors.New("lane queue capacity reached")
var ErrSharedCapacity = errors.New("server queue capacity reached")

// Shared by both directions and all accepted connections of one server.
// In-flight frames and QUIC receive windows are separately bounded by stream
// count, MaxFrameSize, ConfigMulti and the server's connection limit.
type queueBudget struct {
	limit int64
	used  atomic.Int64
	peak  atomic.Int64
}

func (b *queueBudget) reserve(n int) bool {
	if b == nil {
		return true
	}
	for {
		used := b.used.Load()
		next := used + int64(n)
		if next > b.limit {
			return false
		}
		if b.used.CompareAndSwap(used, next) {
			for peak := b.peak.Load(); next > peak; peak = b.peak.Load() {
				if b.peak.CompareAndSwap(peak, next) {
					break
				}
			}
			return true
		}
	}
}
func (b *queueBudget) release(n int) {
	if b != nil {
		b.used.Add(-int64(n))
	}
}

type frameQueue struct {
	budget   *queueBudget
	mu       sync.Mutex
	lanes    [5][][]byte
	bytes    [5]int
	count    int
	finished bool
	ready    chan struct{}
	changed  chan struct{}
}

func newFrameQueue() *frameQueue {
	return &frameQueue{ready: make(chan struct{}, 1), changed: make(chan struct{})}
}

func frameLane(frame []byte) (int, error) {
	var outer struct {
		Type     string `json:"type"`
		Envelope struct {
			Header struct {
				Kind    string `json:"k"`
				Channel string `json:"ch"`
			} `json:"hdr"`
		} `json:"envelope"`
	}
	if err := json.Unmarshal(frame, &outer); err != nil {
		return 0, err
	}
	if outer.Type != "v2.frame" || outer.Envelope.Header.Kind == "hs" || outer.Envelope.Header.Kind == "pair" {
		return 0, nil
	}
	switch outer.Envelope.Header.Channel {
	case "ctl":
		return 0, nil
	case "msg":
		return 1, nil
	case "bulk":
		return 2, nil
	case "history":
		return 3, nil
	case "catchup":
		return 4, nil
	default:
		return 0, errors.New("missing or invalid envelope channel")
	}
}

func (q *frameQueue) push(frame []byte) error {
	lane, err := frameLane(frame)
	if err != nil {
		return err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.finished {
		return io.ErrClosedPipe
	}
	if (lane == 1 || lane == 3 || lane == 4) && q.bytes[1]+q.bytes[3]+q.bytes[4]+len(frame) > queueByteLimits[1] {
		return ErrQueueCapacity
	}
	if q.count >= maxQueueFrames || q.bytes[lane]+len(frame) > queueByteLimits[lane] {
		return ErrQueueCapacity
	}
	if !q.budget.reserve(len(frame)) {
		return ErrSharedCapacity
	}
	q.lanes[lane] = append(q.lanes[lane], frame)
	q.bytes[lane] += len(frame)
	q.count++
	close(q.changed)
	q.changed = make(chan struct{})
	select {
	case q.ready <- struct{}{}:
	default:
	}
	return nil
}

func (q *frameQueue) finish() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.finished = true
	close(q.changed)
	q.changed = make(chan struct{})
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

func (q *frameQueue) pop(ctx context.Context) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		q.mu.Lock()
		for _, lane := range [...]int{0, 1, 3, 4, 2} {
			if len(q.lanes[lane]) == 0 {
				continue
			}
			frame := q.lanes[lane][0]
			q.lanes[lane][0] = nil
			q.lanes[lane] = q.lanes[lane][1:]
			q.bytes[lane] -= len(frame)
			q.budget.release(len(frame))
			q.count--
			if len(q.lanes[lane]) == 0 {
				q.lanes[lane] = nil
			}
			q.mu.Unlock()
			return frame, nil
		}
		finished := q.finished
		q.mu.Unlock()
		if finished {
			return nil, io.EOF
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-q.ready:
		}
	}
}

// Release queued frames on cancellation or the ordered Host handshake boundary.
// An in-flight writer keeps its frame; each lane writes it before any new key frame.
func (q *frameQueue) discard() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for lane := range q.lanes {
		q.budget.release(q.bytes[lane])
		q.lanes[lane] = nil
		q.bytes[lane] = 0
	}
	q.count = 0
}

// The fixed authenticated Node upstream emits HS2 before any new-session data.
// It is also the boundary for retiring old ciphertext still in this adapter.
func (q *frameQueue) retireBeforeHandshake(frame []byte) {
	read := func(b []byte) (string, string, string, string) {
		var r struct {
			Type     string `json:"type"`
			Envelope struct {
				Header struct {
					Kind string `json:"k"`
					From string `json:"from"`
					To   string `json:"to"`
				} `json:"hdr"`
			} `json:"envelope"`
		}
		if json.Unmarshal(b, &r) != nil {
			return "", "", "", ""
		}
		return r.Type, r.Envelope.Header.Kind, r.Envelope.Header.From, r.Envelope.Header.To
	}
	t, k, from, to := read(frame)
	if t != "v2.frame" || k != "hs" {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for lane := range q.lanes {
		old := q.lanes[lane]
		kept := old[:0]
		for _, b := range old {
			kind, _, f, target := read(b)
			if kind == "v2.frame" && f == from && target == to {
				q.bytes[lane] -= len(b)
				q.count--
				q.budget.release(len(b))
			} else {
				kept = append(kept, b)
			}
		}
		clear(old[len(kept):])
		q.lanes[lane] = kept
	}
}
