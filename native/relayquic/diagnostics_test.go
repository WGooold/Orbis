package relayquic

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/gorilla/websocket"
)

func TestMultiOptInMetadataPreservesTrafficAndJoinsWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata.jsonl")
	t.Setenv("ORBIS_QUIC_DIAGNOSTICS_FILE", path)
	address, tlsConfig := multiAdapter(t, func(ws *websocket.Conn) {
		for {
			kind, b, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, b) != nil {
				return
			}
		}
	})
	c := dialMultiTest(t, address, tlsConfig)
	payload := laneFrame(2, 7)
	if err := c.WriteLane(2, payload); err != nil {
		t.Fatal(err)
	}
	got, err := c.ReadLane(2)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatal("traffic changed", err)
	}
	c.Close()
	c.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("你好")) {
		t.Fatal("metadata included payload")
	}
	found := false
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte{'\n'}) {
		var s struct {
			Type  string    `json:"type"`
			Final bool      `json:"final"`
			Bytes [3]uint64 `json:"bytes"`
		}
		if err := json.Unmarshal(line, &s); err != nil {
			t.Fatal(err)
		}
		if s.Type == "quic.writer" && s.Final && s.Bytes[2] >= uint64(len(payload)) {
			found = true
		}
	}
	if !found {
		t.Fatal("missing final per-lane writer metadata")
	}
}
