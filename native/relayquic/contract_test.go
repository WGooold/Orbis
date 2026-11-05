package relayquic

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

type contractFixture struct {
	input io.WriteCloser
	lines chan []byte
}

func (f *contractFixture) next(t *testing.T, result any) {
	t.Helper()
	select {
	case line, ok := <-f.lines:
		if !ok {
			t.Fatal("contract fixture exited before responding")
		}
		if err := json.Unmarshal(line, result); err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("contract fixture response timeout")
	}
}

func (f *contractFixture) call(t *testing.T, request any, result any) {
	t.Helper()
	if err := json.NewEncoder(f.input).Encode(request); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Result json.RawMessage
		Error  string
	}
	f.next(t, &response)
	if response.Error != "" {
		t.Fatal(response.Error)
	}
	if err := json.Unmarshal(response.Result, result); err != nil {
		t.Fatal(err)
	}
}

func startContractFixture(t *testing.T) (*contractFixture, string, string, int) {
	t.Helper()
	node := os.Getenv("ORBIS_TEST_NODE")
	if node == "" {
		t.Skip("set ORBIS_TEST_NODE after npm run typecheck for WS/QUIC contract comparison")
	}
	p := exec.Command(node, "testdata/transport-contract.mjs")
	stdout, err := p.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	input, err := p.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	p.Stderr = os.Stderr
	if err = p.Start(); err != nil {
		t.Fatal(err)
	}
	f := &contractFixture{input: input, lines: make(chan []byte, 1)}
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		defer close(f.lines)
		s := bufio.NewScanner(stdout)
		s.Buffer(make([]byte, 4096), 4*MaxFrameSize)
		for s.Scan() {
			f.lines <- append([]byte(nil), s.Bytes()...)
		}
	}()
	t.Cleanup(func() {
		_ = p.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- p.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("fixture exit: %v", err)
			}
		case <-time.After(5 * time.Second):
			_ = p.Process.Kill()
			<-done
			t.Error("fixture failed to shut down")
		}
		_ = input.Close()
		// Drain any last RPC reply even when the test stopped at an assertion.
		for range f.lines {
		}
		<-scanned
	})
	var metadata struct {
		Upstream, Credential string
		Version              int
	}
	f.next(t, &metadata)
	if metadata.Upstream == "" {
		t.Fatal("missing fixture endpoint")
	}
	return f, metadata.Upstream, metadata.Credential, metadata.Version
}

type contractSocket struct {
	write func([]byte) error
	read  func() ([]byte, error)
	close func()
}

func contractConnection(t *testing.T, mode, upstream string) contractSocket {
	t.Helper()
	if mode == "ws" {
		ws, _, err := websocket.DefaultDialer.Dial(upstream, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = ws.Close() })
		return contractSocket{close: func() { _ = ws.Close() }, write: func(b []byte) error { return ws.WriteMessage(websocket.TextMessage, b) },
			read: func() ([]byte, error) {
				_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
				_, b, err := ws.ReadMessage()
				return b, err
			}}
	}
	serverTLS, clientTLS := testTLS(t)
	config := Config()
	if mode == "quic-v2" {
		config = ConfigMulti()
		serverTLS.NextProtos = []string{ALPNMulti}
	}
	listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, config)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, upstream, 4) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("adapter failed to release pumps")
		}
	})
	if mode == "quic-v2" {
		client := dialMultiTest(t, listener.Addr().String(), clientTLS)
		return contractSocket{close: client.Close, write: client.Write, read: func() ([]byte, error) {
			for _, stream := range client.streams {
				_ = stream.SetReadDeadline(time.Now().Add(5 * time.Second))
			}
			return client.Read()
		}}
	}
	client := dialTest(t, listener.Addr().String(), clientTLS)
	return contractSocket{close: client.Close, write: client.Write, read: func() ([]byte, error) {
		_ = client.stream.SetReadDeadline(time.Now().Add(5 * time.Second))
		return client.Read()
	}}
}

type contractDevice struct {
	f      *contractFixture
	socket contractSocket
}

func (d contractDevice) frames(t *testing.T, frames []json.RawMessage) {
	t.Helper()
	for _, frame := range frames {
		if err := d.socket.write(frame); err != nil {
			t.Fatal(err)
		}
	}
}

func (d contractDevice) read(t *testing.T) json.RawMessage {
	t.Helper()
	frame, err := d.socket.read()
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func (d contractDevice) authenticate(t *testing.T, credential string, version int) {
	t.Helper()
	frame, err := json.Marshal(map[string]any{"type": "device.authenticate", "protocolVersion": version, "credential": credential})
	if err != nil {
		t.Fatal(err)
	}
	d.frames(t, []json.RawMessage{frame})
	var ready struct{ Type string }
	if err := json.Unmarshal(d.read(t), &ready); err != nil || ready.Type != "device.ready" {
		t.Fatalf("Relay authentication: %+v %v", ready, err)
	}
}

func (d contractDevice) receive(t *testing.T) contractResponse {
	t.Helper()
	for range 1000 {
		var response contractResponse
		d.f.call(t, map[string]any{"op": "receive", "frame": d.read(t)}, &response)
		if response.Complete {
			return response
		}
	}
	t.Fatal("payload exceeded bounded reassembly iterations")
	return contractResponse{}
}

func (d contractDevice) handshake(t *testing.T) {
	t.Helper()
	var outgoing contractResponse
	d.f.call(t, map[string]any{"op": "hello"}, &outgoing)
	d.frames(t, outgoing.Frames)
	var hs struct{ Envelope json.RawMessage }
	if err := json.Unmarshal(d.read(t), &hs); err != nil {
		t.Fatal(err)
	}
	d.f.call(t, map[string]any{"op": "accept", "envelope": hs.Envelope}, &outgoing)
	d.frames(t, outgoing.Frames)
	if bootstrap := d.receive(t); bootstrap.Lane != "ctl" || bootstrap.Sequence != 1 {
		t.Fatalf("expected fresh authenticated Host bootstrap: %+v", bootstrap)
	}
}

func (d contractDevice) send(t *testing.T, tag, lane string) contractPayload {
	t.Helper()
	var outgoing contractResponse
	d.f.call(t, map[string]any{"op": "send", "tag": tag, "lane": lane, "kind": "data", "size": 5}, &outgoing)
	d.frames(t, outgoing.Frames)
	var expected contractPayload
	if err := json.Unmarshal(outgoing.Expected, &expected); err != nil {
		t.Fatal(err)
	}
	return expected
}

func (d contractDevice) roundtrip(t *testing.T, tag, lane string) {
	t.Helper()
	want := d.send(t, tag, lane)
	got := d.receive(t)
	if (contractPayload{got.Lane, got.Kind, got.Digest}) != want {
		t.Fatalf("changed content across transport switch: %+v want %+v", got, want)
	}
}

// Exercise the actual Node ownership boundary, including an old connection that
// never received the phone's close. This is not a test of mobile mode selection.
func TestTransportSwitchPreservesHostSessionContract(t *testing.T) {
	for _, initial := range []string{"ws", "quic", "quic-v2"} {
		t.Run(initial, func(t *testing.T) {
			f, upstream, credential, version := startContractFixture(t)
			active := contractDevice{f, contractConnection(t, initial, upstream)}
			active.authenticate(t, credential, version)
			active.handshake(t)
			mode, delivered, confirmed := initial, 0, 1
			for range 2 {
				nextMode := "quic-v2"
				if mode != "ws" {
					nextMode = "ws"
				}
				// A losing, unauthenticated candidate must not disturb the live keys.
				loser := contractConnection(t, nextMode, upstream)
				active.roundtrip(t, "during-prepare", "ctl")
				delivered++
				loser.close()
				active.roundtrip(t, "after-cancel", "ctl")
				delivered++
				candidate := contractDevice{f, contractConnection(t, nextMode, upstream)}
				// Host has handled this request, but the phone does not apply its reply.
				// Reconnection cannot infer that the operation was never executed.
				active.send(t, "unconfirmed-at-handoff", "ctl")
				_ = active.read(t)
				delivered++
				candidate.authenticate(t, credential, version)
				// Intentionally leave old transport open until server-side retirement.
				if frame, err := active.socket.read(); err == nil {
					t.Fatalf("retired socket still receiving: %s", frame)
				} else if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
					t.Fatalf("server never retired the old transport: %v", err)
				}
				active.socket.close()
				active = candidate
				active.handshake(t)
				confirmed++
				for _, lane := range []string{"ctl", "msg", "bulk"} {
					active.roundtrip(t, "after-switch", lane)
					delivered++
				}
				var stats struct {
					Delivered, Confirmed int
					Errors               []string
				}
				f.call(t, map[string]any{"op": "stats"}, &stats)
				if stats.Delivered != delivered || stats.Confirmed != confirmed || len(stats.Errors) != 0 {
					t.Fatalf("switch changed Host delivery or handshake facts: %+v want %d/%d", stats, delivered, confirmed)
				}
				mode = nextMode
			}
		})
	}
}

type contractPayload struct{ Lane, Kind, Digest string }
type contractResponse struct {
	Frames             []json.RawMessage
	Expected           json.RawMessage
	Complete           bool
	Lane, Kind, Digest string
	Sequence           int
}

// A real WS baseline and a real QUIC candidate execute exactly the same tests.
// This characterizes the transport boundary, not backend/SQLite business logic.
func TestTransportPreservesExistingHostContract(t *testing.T) {
	for _, mode := range []string{"ws", "quic", "quic-v2"} {
		t.Run(mode, func(t *testing.T) {
			f, upstream, credential, version := startContractFixture(t)
			socket := contractConnection(t, mode, upstream)
			write := func(v any) {
				t.Helper()
				b, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				if err = socket.write(b); err != nil {
					t.Fatal(err)
				}
			}
			frames := func(list []json.RawMessage) {
				t.Helper()
				for _, frame := range list {
					if err := socket.write(frame); err != nil {
						t.Fatal(err)
					}
				}
			}
			read := func() json.RawMessage {
				t.Helper()
				b, err := socket.read()
				if err != nil {
					t.Fatal(err)
				}
				return b
			}
			receive := func() contractResponse {
				t.Helper()
				for i := 0; i < 1000; i++ {
					var result contractResponse
					f.call(t, map[string]any{"op": "receive", "frame": read()}, &result)
					if result.Complete {
						return result
					}
				}
				t.Fatal("payload exceeded bounded reassembly iterations")
				return contractResponse{}
			}
			handshake := func() {
				t.Helper()
				var outgoing contractResponse
				f.call(t, map[string]any{"op": "hello"}, &outgoing)
				frames(outgoing.Frames)
				var hs struct{ Envelope json.RawMessage }
				if err := json.Unmarshal(read(), &hs); err != nil {
					t.Fatal(err)
				}
				f.call(t, map[string]any{"op": "accept", "envelope": hs.Envelope}, &outgoing)
				frames(outgoing.Frames)
				ready := receive()
				if ready.Lane != "ctl" || ready.Sequence != 1 {
					t.Fatalf("new E2E bootstrap: %+v", ready)
				}
			}
			write(map[string]any{"type": "device.authenticate", "protocolVersion": version, "credential": credential})
			var ready struct{ Type string }
			if err := json.Unmarshal(read(), &ready); err != nil || ready.Type != "device.ready" {
				t.Fatalf("Relay auth response: %+v %v", ready, err)
			}
			handshake()
			var replay []json.RawMessage
			for _, spec := range []struct {
				lane, kind string
				size       int
			}{{"ctl", "data", 3}, {"msg", "data", 20000}, {"bulk", "data", 7000}, {"bulk", "bin", 256 * 1024}, {"ctl", "ping", 0}} {
				var outgoing contractResponse
				f.call(t, map[string]any{"op": "send", "tag": "roundtrip", "lane": spec.lane, "kind": spec.kind, "size": spec.size}, &outgoing)
				frames(outgoing.Frames)
				got := receive()
				var expected contractPayload
				if err := json.Unmarshal(outgoing.Expected, &expected); err != nil {
					t.Fatal(err)
				}
				if (contractPayload{got.Lane, got.Kind, got.Digest}) != expected {
					t.Fatalf("payload changed: %+v want %+v", got, expected)
				}
				if spec.lane == "ctl" && spec.kind == "data" {
					replay = outgoing.Frames
				}
			}
			// Replay cannot execute again. A following ctl exchange fences the same FIFO.
			frames(replay)
			var fence contractResponse
			f.call(t, map[string]any{"op": "send", "tag": "fence", "lane": "ctl", "kind": "data", "size": 1}, &fence)
			frames(fence.Frames)
			receive()
			var stats struct {
				Delivered, Confirmed, SnapshotWrites int
				Errors                               []string
			}
			f.call(t, map[string]any{"op": "stats"}, &stats)
			if stats.Delivered != 5 || stats.Confirmed != 1 || stats.SnapshotWrites != 1 || len(stats.Errors) != 0 {
				t.Fatalf("Host state: %+v", stats)
			}
			// Bursts may interleave channels, but every channel must preserve its own FIFO.
			var burst struct{ Expected []contractPayload }
			f.call(t, map[string]any{"op": "burst"}, &burst)
			want, got := map[string][]string{}, map[string][]string{}
			for _, p := range burst.Expected {
				want[p.Lane] = append(want[p.Lane], p.Digest)
			}
			for range burst.Expected {
				p := receive()
				got[p.Lane] = append(got[p.Lane], p.Digest)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatal("cross-channel burst lost content or changed per-channel order")
			}
			// Same socket, new HS1: existing Host resets keys/sequence and replays bootstrap.
			handshake()
			f.call(t, map[string]any{"op": "send", "tag": "new-session", "lane": "ctl", "kind": "data", "size": 1}, &fence)
			frames(fence.Frames)
			receive()
			f.call(t, map[string]any{"op": "stats"}, &stats)
			if stats.Delivered != 6 || stats.Confirmed != 2 || len(stats.Errors) != 0 {
				t.Fatalf("rehandshake failed: %+v", stats)
			}
		})
	}
}
