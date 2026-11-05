package relayquic

import (
	"context"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

func TestPriorityQueueStrictPriorityFIFOAndFinish(t *testing.T) {
	q := newFrameQueue()
	for _, ch := range []string{"bulk", "msg", "ctl"} {
		for n := 0; n < 3; n++ {
			if err := q.push([]byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"piece","ch":%q},"ct":%q}}`, ch, fmt.Sprint(n)))); err != nil {
				t.Fatal(err)
			}
		}
	}
	q.finish()
	for _, ch := range []string{"ctl", "msg", "bulk"} {
		for n := 0; n < 3; n++ {
			frame, err := q.pop(context.Background())
			if err != nil || !strings.Contains(string(frame), fmt.Sprintf(`"ch":%q`, ch)) || !strings.Contains(string(frame), fmt.Sprintf(`"ct":%q`, fmt.Sprint(n))) {
				t.Fatalf("priority/FIFO: %s %v", frame, err)
			}
		}
	}
	if _, err := q.pop(context.Background()); err != io.EOF {
		t.Fatalf("finish: %v", err)
	}
	if q.count != 0 || q.bytes != [5]int{} {
		t.Fatal("queue retained payload budget")
	}
}

func TestPriorityQueueBoundedAndRejectsUnknownChannel(t *testing.T) {
	q := newFrameQueue()
	if q.push([]byte(`{"type":"v2.frame","envelope":{"hdr":{"ch":"unknown"}}}`)) == nil {
		t.Fatal("accepted unknown channel")
	}
	if q.push([]byte(`{"payload":"`+strings.Repeat("a", queueByteLimits[0])+`"}`)) == nil {
		t.Fatal("accepted over-budget frame")
	}
	for i := 0; i < maxQueueFrames; i++ {
		if err := q.push([]byte(`{}`)); err != nil {
			t.Fatal(err)
		}
	}
	if q.push([]byte(`{}`)) == nil {
		t.Fatal("accepted too many frames")
	}
	// Overflow did not silently evict any already queued frame.
	if q.count != maxQueueFrames {
		t.Fatal("queue dropped accepted frames")
	}
}

func TestPriorityQueueCancellationWakesBlockedWriter(t *testing.T) {
	q := newFrameQueue()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := q.pop(ctx); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("writer leaked")
	}
}

func TestSharedQueueBudgetRejectsWithoutEvictionAndReturnsAllReservations(t *testing.T) {
	budget := &queueBudget{limit: 1024}
	queues := make([]*frameQueue, 32)
	for i := range queues {
		queues[i] = newFrameQueue()
		queues[i].budget = budget
	}
	frame := []byte(`{"payload":"` + strings.Repeat("a", 200) + `"}`)
	accepted := 0
	for _, q := range queues {
		if err := q.push(frame); err == nil {
			accepted++
		} else if err != ErrSharedCapacity {
			t.Fatal(err)
		}
	}
	if accepted != 4 || budget.used.Load() != int64(accepted*len(frame)) || budget.peak.Load() > budget.limit {
		t.Fatal("global queue budget was not enforced")
	}
	// Both FIFO reader variants release precisely the bytes removed.
	if _, err := queues[0].pop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := queues[1].popLane(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	for _, q := range queues {
		q.discard()
		q.discard()
	}
	if budget.used.Load() != 0 {
		t.Fatal("cancel retained shared reservations")
	}
	if err := queues[31].push(frame); err != nil {
		t.Fatal("other connection could not reuse budget", err)
	}
	queues[31].discard()
}
