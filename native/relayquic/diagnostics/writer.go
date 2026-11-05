package diagnostics

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// WriterMeter aggregates local stream Write latency, not network delivery.
type WriterMeter struct {
	mu          sync.Mutex
	f           *os.File
	start, last time.Time
	closed      bool
	s           WriterSnapshot
}
type WriterSnapshot struct {
	Type                  string     `json:"type"`
	Connection            string     `json:"connection"`
	PID                   int        `json:"pid"`
	At                    string     `json:"at"`
	ElapsedMS             int64      `json:"elapsedMs"`
	Final                 bool       `json:"final"`
	Frames                [5]uint64  `json:"frames"`
	Bytes                 [5]uint64  `json:"bytes"`
	BlockedMS             [5]float64 `json:"writeDurationMs"`
	MaxWriteMS            [5]float64 `json:"maxWriteDurationMs"`
	MaxObservedQueueBytes [5]int     `json:"maxObservedQueueBytes"`
}

func NewWriterMeter(path, label string) (*WriterMeter, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &WriterMeter{f: f, start: time.Now(), s: WriterSnapshot{Type: "quic.writer", Connection: label, PID: os.Getpid()}}, nil
}
func (m *WriterMeter) Observe(lane, n int, d time.Duration, queue [3]int) {
	m.ObserveLane(lane, n, d, queue[:])
}
func (m *WriterMeter) ObserveLane(lane, n int, d time.Duration, queue []int) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.s.Frames[lane]++
	m.s.Bytes[lane] += uint64(n)
	m.s.BlockedMS[lane] += float64(d) / float64(time.Millisecond)
	m.s.MaxWriteMS[lane] = max(m.s.MaxWriteMS[lane], float64(d)/float64(time.Millisecond))
	for i := range queue {
		m.s.MaxObservedQueueBytes[i] = max(m.s.MaxObservedQueueBytes[i], queue[i])
	}
	if time.Since(m.last) >= time.Second {
		m.emit(false)
	}
}
func (m *WriterMeter) Close() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		m.emit(true)
		m.closed = true
		_ = m.f.Close()
	}
}
func (m *WriterMeter) emit(final bool) {
	now := time.Now()
	m.last = now
	m.s.At = now.UTC().Format(time.RFC3339Nano)
	m.s.ElapsedMS = now.Sub(m.start).Milliseconds()
	m.s.Final = final
	b, _ := json.Marshal(m.s)
	_, _ = m.f.Write(append(b, '\n'))
}
