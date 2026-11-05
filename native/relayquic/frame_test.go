package relayquic

import (
	"bytes"
	"encoding/binary"
	"io"
	"strings"
	"testing"
)

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.Buffer.Write(p)
}

func TestFramesPreserveBytesAndBoundaries(t *testing.T) {
	w := &shortWriter{}
	frames := []string{`{"message":"你好 👋"}`, `{"n":2}`, `{"payload":"` + strings.Repeat("x", MaxFrameSize-14) + `"}`}
	for _, f := range frames {
		if err := WriteFrame(w, []byte(f)); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range frames {
		got, err := ReadFrame(w)
		if err != nil || string(got) != f {
			t.Fatalf("frame mismatch: %v", err)
		}
	}
	if _, err := ReadFrame(w); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestRejectMalformedFrames(t *testing.T) {
	for _, payload := range [][]byte{nil, []byte(`null`), []byte(`[]`), []byte(`"text"`), []byte(`{"a":`), []byte{'{', '"', 'x', '"', ':', '"', 255, '"', '}'}, []byte(`{"x":"` + strings.Repeat("a", MaxFrameSize) + `"}`)} {
		var out bytes.Buffer
		if err := WriteFrame(&out, payload); err == nil || out.Len() != 0 {
			t.Fatalf("accepted invalid frame, len=%d", len(payload))
		}
	}
	for _, size := range []uint32{0, MaxFrameSize + 1, 0xffffffff} {
		var h [4]byte
		binary.BigEndian.PutUint32(h[:], size)
		if _, err := ReadFrame(bytes.NewReader(h[:])); err != ErrFrame {
			t.Fatalf("invalid length: %v", err)
		}
	}
	var good bytes.Buffer
	_ = WriteFrame(&good, []byte(`{"ok":true}`))
	for n := 1; n < good.Len(); n++ {
		if _, err := ReadFrame(bytes.NewReader(good.Bytes()[:n])); err == nil {
			t.Fatal("accepted truncated frame")
		}
	}
}

func TestHandshakeHasOneMeaning(t *testing.T) {
	for _, data := range []string{`{"type":"transport.open","version":2}`, `{"type":"transport.open","version":1,"target":"example.com"}`, `{"type":"transport.open","version":1.1}`} {
		if handshakeFrame([]byte(data), "transport.open") {
			t.Fatal("accepted invalid handshake")
		}
	}
}

func FuzzFrame(f *testing.F) {
	f.Add([]byte{0, 0, 0, 2, '{', '}'})
	f.Fuzz(func(t *testing.T, data []byte) {
		frame, err := ReadFrame(bytes.NewReader(data))
		if err == nil {
			var b bytes.Buffer
			if WriteFrame(&b, frame) != nil {
				t.Fatal("accepted unencodable frame")
			}
		}
	})
}
