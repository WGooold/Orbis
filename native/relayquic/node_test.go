package relayquic

import (
	"bufio"
	"context"
	"encoding/json"
	quic "github.com/quic-go/quic-go"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestActualNodeRelayHostAndQUICDevice(t *testing.T) {
	node := os.Getenv("ORBIS_TEST_NODE")
	if node == "" {
		t.Skip("set ORBIS_TEST_NODE after npm run typecheck for actual Relay integration")
	}
	process := exec.Command(node, "testdata/node-relay.mjs")
	stdout, err := process.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	process.Stderr = os.Stderr
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = process.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- process.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = process.Process.Kill()
			<-done
			t.Error("fixture did not exit gracefully")
		}
	})
	type metadata struct {
		Upstream, Credential string
		Version              int
		Frame                json.RawMessage
	}
	info := make(chan metadata, 1)
	go func() {
		var m metadata
		scan := bufio.NewScanner(stdout)
		if scan.Scan() {
			_ = json.Unmarshal(scan.Bytes(), &m)
		}
		info <- m
	}()
	var m metadata
	select {
	case m = <-info:
	case <-time.After(5 * time.Second):
		t.Fatal("Node fixture startup timeout")
	}
	if m.Upstream == "" {
		t.Fatal("missing Node fixture endpoint")
	}
	serverTLS, clientTLS := testTLS(t)
	listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, Config())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, m.Upstream, 4) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("adapter failed to stop")
		}
	})
	for iteration := 0; iteration < 2; iteration++ {
		client := dialTest(t, listener.Addr().String(), clientTLS)
		_ = client.stream.SetReadDeadline(time.Now().Add(3 * time.Second))
		auth, _ := json.Marshal(map[string]any{"type": "device.authenticate", "protocolVersion": m.Version, "credential": m.Credential})
		if err = client.Write(auth); err != nil {
			t.Fatal(err)
		}
		ready, err := client.Read()
		if err != nil || !strings.Contains(string(ready), "device.ready") {
			t.Fatalf("authenticate: %s %v", ready, err)
		}
		if err = client.Write(m.Frame); err != nil {
			t.Fatal(err)
		}
		frame, err := client.Read()
		if err != nil || !strings.Contains(string(frame), "v2.frame") {
			t.Fatalf("encrypted forward: %s %v", frame, err)
		}
		client.Close()
	}
	client := dialTest(t, listener.Addr().String(), clientTLS)
	_ = client.stream.SetReadDeadline(time.Now().Add(3 * time.Second))
	_ = client.Write([]byte(`{"type":"device.authenticate","protocolVersion":-1,"credential":"bad"}`))
	frame, err := client.Read()
	if err != nil || !strings.Contains(string(frame), "protocol_version_mismatch") {
		t.Fatalf("final protocol error: %s %v", frame, err)
	}
}
