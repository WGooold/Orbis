package hostipc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/WGooold/Orbis/native/relayquic"
)

type blockedClient struct {
	closed chan struct{}
	once   sync.Once
	reads  [5]chan []byte
}

func (c *blockedClient) Close() { c.once.Do(func() { close(c.closed) }) }
func (c *blockedClient) ReadLane(lane int) ([]byte, error) {
	select {
	case b := <-c.reads[lane]:
		return b, nil
	case <-c.closed:
		return nil, io.EOF
	}
}
func (c *blockedClient) WriteLane(lane int, b []byte) error {
	if lane == 2 {
		<-c.closed
		return io.EOF
	}
	select {
	case c.reads[lane] <- b:
		return nil
	case <-c.closed:
		return io.EOF
	}
}

func TestIndependentIPCLanesAndParentEOFJoinEveryPump(t *testing.T) {
	for _, version := range []int{2, 3} {
		t.Run(fmt.Sprint(version), func(t *testing.T) { testIndependentIPCLanes(t, version) })
	}
}
func testIndependentIPCLanes(t *testing.T, version int) {
	input, parent := io.Pipe()
	output, childOutput := io.Pipe()
	defer output.Close()
	c := &blockedClient{closed: make(chan struct{})}
	for lane := range c.reads {
		c.reads[lane] = make(chan []byte, 1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, input, childOutput, func(context.Context, Config) (laneClient, error) { return c, nil })
		childOutput.Close()
	}()
	defer parent.Close()
	token := strings.Repeat("a", 64)
	config, _ := json.Marshal(Config{Address: "127.0.0.1:443", ServerName: "localhost", Token: token, StreamVersion: version})
	if err := relayquic.WriteFrame(parent, config); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(output)
	var listening struct {
		Port int `json:"port"`
	}
	if err := decoder.Decode(&listening); err != nil {
		t.Fatal(err)
	}
	address := fmt.Sprintf("127.0.0.1:%d", listening.Port)
	// A foreign local process cannot acquire a lane by guessing its role.
	wrong, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	_ = wrong.SetDeadline(time.Now().Add(time.Second))
	_ = WritePacket(wrong, Data, []byte(`{"token":"wrong","lane":0}`))
	if _, _, err := ReadPacket(wrong); err == nil {
		t.Fatal("foreign IPC accepted")
	}
	wrong.Close()
	count := 3
	if version == 3 {
		count = 5
	}
	lanes := make([]net.Conn, count)
	for lane := range lanes {
		conn, err := net.Dial("tcp", address)
		if err != nil {
			t.Fatal(err)
		}
		lanes[lane] = conn
		defer conn.Close()
		auth, _ := json.Marshal(map[string]any{"token": token, "lane": lane})
		if err := WritePacket(conn, Data, auth); err != nil {
			t.Fatal(err)
		}
	}
	var ready map[string]string
	if err := decoder.Decode(&ready); err != nil || ready["type"] != "transport.ready" {
		t.Fatalf("ready: %v", err)
	}
	_ = WritePacket(lanes[2], Data, []byte(`{"bulk":"blocked"}`))
	marker := []byte(`{"ctl":"still makes progress"}`)
	_ = WritePacket(lanes[0], Data, marker)
	_ = lanes[0].SetReadDeadline(time.Now().Add(time.Second))
	ops := map[byte][]byte{}
	for range 2 {
		op, b, err := ReadPacket(lanes[0])
		if err != nil {
			t.Fatal(err)
		}
		ops[op] = b
	}
	if !bytes.Equal(ops[Data], marker) || len(ops[Written]) != 4 {
		t.Fatal("lost data or local write receipt")
	}
	parent.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("EOF failed to join blocked pumps")
	}
	for _, conn := range lanes {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		if _, _, err := ReadPacket(conn); err == nil {
			t.Fatal("lane survived parent EOF")
		}
	}
}

func TestPacketSizeAndTruncation(t *testing.T) {
	for _, b := range [][]byte{{0, 0, 0, 0, 0}, {0xff, 0xff, 0xff, 0xff, 0}, {0, 0, 0, 1, 2}, {0, 0, 0, 3, 0, 1}} {
		if _, _, err := ReadPacket(bytes.NewReader(b)); err == nil {
			t.Fatal("accepted invalid IPC frame")
		}
	}
}
