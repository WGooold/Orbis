// Package diagnostics records bounded QUIC metadata for isolated performance
// fixtures. It never serializes packet contents, credentials or stream data.
package diagnostics

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"

	quic "github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/qlog"
	"github.com/quic-go/quic-go/qlogwriter"
)

type Snapshot struct {
	Type       string            `json:"type"`
	At         string            `json:"at"`
	Connection string            `json:"connection"`
	Client     bool              `json:"client"`
	PID        int               `json:"pid"`
	ElapsedMS  int64             `json:"elapsedMs"`
	Final      bool              `json:"final"`
	Metrics    uint64            `json:"metricsEvents"`
	RTTMS      float64           `json:"smoothedRttMs"`
	MinRTTMS   float64           `json:"minRttMs"`
	Cwnd       int               `json:"cwndBytes"`
	Flight     int               `json:"bytesInFlight"`
	MaxFlight  int               `json:"maxBytesInFlight"`
	PTO        uint32            `json:"ptoCount"`
	MaxPTO     uint32            `json:"maxPtoCount"`
	Lost       uint64            `json:"packetLostEvents"`
	Sent       uint64            `json:"packetSentEvents"`
	Received   uint64            `json:"packetReceivedEvents"`
	Frames     map[string]uint64 `json:"flowControlFrames"`
	States     map[string]uint64 `json:"congestionStates"`
}

// Configure does nothing unless the fixture explicitly supplies a file path.
// Open failures are returned so a diagnostic run cannot silently lose evidence.
func Configure(config *quic.Config, path string) error {
	if path == "" {
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_ = f.Close()
	config.Tracer = func(_ context.Context, client bool, id quic.ConnectionID) qlogwriter.Trace {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return nil
		}
		return newTrace(f, client, id.String())
	}
	return nil
}

type trace struct {
	mu          sync.Mutex
	w           io.WriteCloser
	start, last time.Time
	refs        int
	closed      bool
	s           Snapshot
}

func newTrace(w io.WriteCloser, client bool, id string) *trace {
	return &trace{w: w, start: time.Now(), s: Snapshot{Type: "quic.metadata", Connection: id, Client: client, PID: os.Getpid(), Frames: map[string]uint64{}, States: map[string]uint64{}}}
}
func (t *trace) AddProducer() qlogwriter.Recorder {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.refs++
	return &recorder{t: t}
}

type recorder struct {
	t    *trace
	once sync.Once
}

func (r *recorder) Close() error {
	r.once.Do(func() {
		t := r.t
		t.mu.Lock()
		defer t.mu.Unlock()
		t.refs--
		if t.refs == 0 && !t.closed {
			t.emit(true)
			t.closed = true
			_ = t.w.Close()
		}
	})
	return nil
}
func (r *recorder) RecordEvent(e qlogwriter.Event) {
	// quic-go emits value events; accept pointer events as well for callers.
	switch value := e.(type) {
	case qlog.MetricsUpdated:
		e = &value
	case qlog.PTOCountUpdated:
		e = &value
	case qlog.PacketLost:
		e = &value
	case qlog.CongestionStateUpdated:
		e = &value
	case qlog.PacketSent:
		e = &value
	case qlog.PacketReceived:
		e = &value
	}
	t := r.t
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	switch e := e.(type) {
	case *qlog.MetricsUpdated:
		t.s.Metrics++
		t.s.RTTMS = float64(e.SmoothedRTT) / float64(time.Millisecond)
		t.s.MinRTTMS = float64(e.MinRTT) / float64(time.Millisecond)
		t.s.Cwnd = e.CongestionWindow
		t.s.Flight = e.BytesInFlight
		t.s.MaxFlight = max(t.s.MaxFlight, e.BytesInFlight)
	case *qlog.PTOCountUpdated:
		t.s.PTO = e.PTOCount
		t.s.MaxPTO = max(t.s.MaxPTO, e.PTOCount)
	case *qlog.PacketLost:
		t.s.Lost++
	case *qlog.CongestionStateUpdated:
		t.s.States[e.State.String()]++
	case *qlog.PacketSent:
		t.s.Sent++
		t.frames("sent", e.Frames)
	case *qlog.PacketReceived:
		t.s.Received++
		t.frames("received", e.Frames)
	}
	if time.Since(t.last) >= time.Second {
		t.emit(false)
	}
}
func (t *trace) frames(direction string, frames []qlog.Frame) {
	for _, f := range frames {
		var kind string
		switch f.Frame.(type) {
		case *qlog.DataBlockedFrame:
			kind = "data_blocked"
		case *qlog.StreamDataBlockedFrame:
			kind = "stream_data_blocked"
		case *qlog.MaxDataFrame:
			kind = "max_data"
		case *qlog.MaxStreamDataFrame:
			kind = "max_stream_data"
		}
		if kind != "" {
			t.s.Frames[direction+"."+kind]++
		}
	}
}
func (t *trace) emit(final bool) {
	now := time.Now()
	t.last = now
	t.s.At = now.UTC().Format(time.RFC3339Nano)
	t.s.ElapsedMS = now.Sub(t.start).Milliseconds()
	t.s.Final = final
	b, _ := json.Marshal(t.s)
	b = append(b, '\n')
	_, _ = t.w.Write(b)
}
