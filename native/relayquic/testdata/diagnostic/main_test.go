package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func netPipe() (endpoint, endpoint) {
	a, b := net.Pipe()
	return endpoint{s: a, close: func() { _ = a.Close() }}, endpoint{s: b, close: func() { _ = b.Close() }}
}

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) { return w.Buffer.Write(p[:min(3, len(p))]) }
func TestRecordHandlesPartialWritesAndRejectsSize(t *testing.T) {
	w := &shortWriter{}
	want := request{ID: "fixture", Direction: "upload", DurationMS: 100}
	if e := record(w, want); e != nil {
		t.Fatal(e)
	}
	var got request
	if e := readRecord(w, &got); e != nil || got != want {
		t.Fatal(e, got)
	}
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], 2*1024*1024)
	if readRecord(bytes.NewReader(h[:]), &got) == nil {
		t.Fatal("accepted excessive record")
	}
	if readRecord(bytes.NewReader([]byte{0}), &got) != io.ErrUnexpectedEOF {
		t.Fatal("accepted partial header")
	}
}
func TestVerifyArbitraryReadBoundaries(t *testing.T) {
	all := append(append([]byte{}, pattern...), pattern...)
	var offset uint64
	for len(all) > 0 {
		n := min(997, len(all))
		if !verify(all[:n], offset) {
			t.Fatal("incorrect split")
		}
		all = all[n:]
		offset += uint64(n)
	}
	bad := append([]byte{}, pattern...)
	bad[113] ^= 1
	if verify(bad, 0) {
		t.Fatal("accepted corruption")
	}
}
func TestEarlyEOFDoesNotCompleteWindow(t *testing.T) {
	a, b := netPipe()
	defer a.close()
	go func() { _ = writeAll(b.s, pattern); b.close() }()
	r := receive(a, request{DurationMS: 100}, "tls", "test")
	if r.MeasurementComplete || len(r.Errors) == 0 || r.VerifiedBytes != uint64(len(pattern)) {
		t.Fatalf("bad incomplete result: %+v", r)
	}
}
func TestFixedWindowCountsContinuousBytes(t *testing.T) {
	a, b := netPipe()
	defer a.close()
	go func() {
		for {
			if writeAll(b.s, pattern) != nil {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	r := receive(a, request{WarmupMS: 10, DurationMS: 100}, "tls", "test")
	a.close()
	b.close()
	if !r.MeasurementComplete || len(r.Errors) > 0 || r.WindowBytes == 0 || r.WindowBytes >= r.VerifiedBytes {
		t.Fatalf("bad complete result: %+v", r)
	}
}
