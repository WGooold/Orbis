package diagnostics

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	quic "github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/qlog"
)

type bufferCloser struct {
	bytes.Buffer
	closed bool
}

func (b *bufferCloser) Close() error { b.closed = true; return nil }
func TestMetadataOnlyAndProducerLifetime(t *testing.T) {
	w := &bufferCloser{}
	tr := newTrace(w, true, "fixture")
	a, b := tr.AddProducer(), tr.AddProducer()
	a.RecordEvent(qlog.MetricsUpdated{SmoothedRTT: 300 * time.Millisecond, CongestionWindow: 12345, BytesInFlight: 6789})
	a.RecordEvent(qlog.PacketSent{Frames: []qlog.Frame{{Frame: &qlog.DataBlockedFrame{}}, {Frame: &qlog.StreamFrame{}}}})
	a.RecordEvent(qlog.PTOCountUpdated{PTOCount: 2})
	a.RecordEvent(qlog.PacketLost{})
	_ = a.Close()
	if w.closed {
		t.Fatal("closed before last producer")
	}
	_ = b.Close()
	_ = b.Close()
	if !w.closed {
		t.Fatal("writer not closed")
	}
	lines := bytes.Split(bytes.TrimSpace(w.Bytes()), []byte{'\n'})
	var s Snapshot
	if err := json.Unmarshal(lines[len(lines)-1], &s); err != nil {
		t.Fatal(err)
	}
	if !s.Final || s.RTTMS != 300 || s.Cwnd != 12345 || s.MaxFlight != 6789 || s.Lost != 1 || s.MaxPTO != 2 || s.Frames["sent.data_blocked"] != 1 {
		t.Fatalf("invalid snapshot: %+v", s)
	}
	if bytes.Contains(w.Bytes(), []byte("stream_data")) {
		t.Fatal("serialized stream data")
	}
}
func TestDisabledAndInvalidPath(t *testing.T) {
	c := &quic.Config{}
	if err := Configure(c, ""); err != nil || c.Tracer != nil {
		t.Fatal("diagnostics enabled by default")
	}
	if Configure(c, t.TempDir()+"/missing/trace.jsonl") == nil {
		t.Fatal("ignored invalid diagnostic path")
	}
}
