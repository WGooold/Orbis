// Package relayquic carries the existing Orbis Relay JSON protocol on native QUIC.
package relayquic

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const ALPN = "orbis-relay-v1"
const MaxFrameSize = 2 * 1024 * 1024

var ErrFrame = errors.New("invalid relay frame")

// Validate before allocating from the wire and before emitting any bytes.
func validFrame(data []byte) bool {
	if len(data) == 0 || len(data) > MaxFrameSize || !utf8.Valid(data) || !json.Valid(data) {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(data, &object) == nil && object != nil
}

func ReadFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > MaxFrameSize {
		return nil, ErrFrame
	}
	data := make([]byte, int(n))
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}
	if !validFrame(data) {
		return nil, ErrFrame
	}
	return data, nil
}

func WriteFrame(w io.Writer, data []byte) error {
	if !validFrame(data) {
		return ErrFrame
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	for _, part := range [][]byte{header[:], data} {
		for len(part) > 0 {
			n, err := w.Write(part)
			if err != nil {
				return err
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}

func handshakeFrame(data []byte, kind string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || len(object) != 2 {
		return false
	}
	var t string
	var v int
	return json.Unmarshal(object["type"], &t) == nil && t == kind && json.Unmarshal(object["version"], &v) == nil && v == 1
}
