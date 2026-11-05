package relayquic

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

func multiAdapter(t *testing.T, handler func(*websocket.Conn)) (string, *tls.Config) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, e := upgrader.Upgrade(w, r, nil)
		if e != nil {
			return
		}
		defer ws.Close()
		handler(ws)
	}))
	t.Cleanup(upstream.Close)
	serverTLS, clientTLS := testTLS(t)
	serverTLS.NextProtos = []string{ALPNMulti}
	listener, e := quic.ListenAddr("127.0.0.1:0", serverTLS, ConfigMulti())
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, "ws"+strings.TrimPrefix(upstream.URL, "http")+"/v1/device", 4) }()
	t.Cleanup(func() {
		cancel()
		select {
		case e := <-done:
			if e != nil {
				t.Error(e)
			}
		case <-time.After(5 * time.Second):
			t.Error("multi pumps did not exit")
		}
	})
	return listener.Addr().String(), clientTLS
}
func dialMultiTest(t *testing.T, address string, config *tls.Config) *MultiClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, e := DialMulti(ctx, address, config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(c.Close)
	return c
}
func laneFrame(lane, n int) []byte {
	return []byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":%q},"ct":"你好-%d"}}`, laneNames[lane], n))
}

func TestMultiNativeStreamsRoundTripAndFIFO(t *testing.T) {
	address, config := multiAdapter(t, func(ws *websocket.Conn) {
		for {
			k, b, e := ws.ReadMessage()
			if e != nil {
				return
			}
			if ws.WriteMessage(k, b) != nil {
				return
			}
		}
	})
	c := dialMultiTest(t, address, config)
	var tasks sync.WaitGroup
	for lane := 0; lane < 3; lane++ {
		lane := lane
		tasks.Add(1)
		go func() {
			defer tasks.Done()
			for i := 0; i < 40; i++ {
				b := laneFrame(lane, i)
				if e := c.WriteLane(lane, b); e != nil {
					t.Error(e)
					return
				}
				got, e := c.ReadLane(lane)
				if e != nil || string(got) != string(b) {
					t.Errorf("lane %d seq %d: %s %v", lane, i, got, e)
					return
				}
			}
		}()
	}
	tasks.Wait()
	if c.streams[0].StreamID() == c.streams[1].StreamID() || c.streams[1].StreamID() == c.streams[2].StreamID() {
		t.Fatal("lanes share a stream")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, e := c.conn.OpenStreamSync(ctx); e == nil {
		t.Fatal("fourth stream allowed")
	}
	if c.WriteLane(0, laneFrame(2, 1)) == nil {
		t.Fatal("accepted mismatched channel")
	}
}

func TestMultiBlockedBulkReaderDoesNotBlockControl(t *testing.T) {
	sent := make(chan struct{})
	address, config := multiAdapter(t, func(ws *websocket.Conn) {
		// More than bulk receive credit, below its bounded queue. Reader is not
		// resumed until the control response has completed.
		for i := 0; i < 80; i++ {
			b := []byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"bulk"},"ct":%q}}`, strings.Repeat("b", 64*1024)))
			if ws.WriteMessage(websocket.TextMessage, b) != nil {
				return
			}
		}
		close(sent)
		for {
			k, b, e := ws.ReadMessage()
			if e != nil {
				return
			}
			if ws.WriteMessage(k, b) != nil {
				return
			}
		}
	})
	c := dialMultiTest(t, address, config)
	select {
	case <-sent:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream did not queue bulk")
	}
	want := laneFrame(0, 7)
	if e := c.WriteLane(0, want); e != nil {
		t.Fatal(e)
	}
	_ = c.streams[0].SetReadDeadline(time.Now().Add(time.Second))
	got, e := c.ReadLane(0)
	if e != nil || string(got) != string(want) {
		t.Fatalf("ctl blocked behind bulk: %s %v", got, e)
	}
	for i := 0; i < 80; i++ {
		if _, e = c.ReadLane(2); e != nil {
			t.Fatal(e)
		}
	}
}

func TestMultiRoleValidationBeforeUpstreamAuthentication(t *testing.T) {
	for _, roles := range [][]string{{"ctl", "ctl"}, {"unknown"}, {"msg", "bulk", "bulk"}} {
		t.Run(strings.Join(roles, "-"), func(t *testing.T) {
			var upstream atomic.Int32
			address, config := multiAdapter(t, func(ws *websocket.Conn) { upstream.Add(1) })
			config = config.Clone()
			config.NextProtos = []string{ALPNMulti}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			conn, e := quic.DialAddr(ctx, address, config, ConfigMulti())
			if e != nil {
				t.Fatal(e)
			}
			defer conn.CloseWithError(0, "")
			var first *quic.Stream
			for _, role := range roles {
				s, e := conn.OpenStreamSync(ctx)
				if e != nil {
					break
				}
				if first == nil {
					first = s
				}
				_ = WriteFrame(s, []byte(fmt.Sprintf(`{"type":"transport.open","version":2,"lane":%q}`, role)))
			}
			_ = first.SetReadDeadline(time.Now().Add(time.Second))
			if _, e = ReadFrame(first); e == nil {
				t.Fatal("invalid roles accepted")
			}
			if upstream.Load() != 0 {
				t.Fatal("invalid candidate reached upstream")
			}
		})
	}
}

func TestMultiIncompleteSetupAndCancellationReleaseServer(t *testing.T) {
	var upstream atomic.Int32
	address, config := multiAdapter(t, func(ws *websocket.Conn) { upstream.Add(1) })
	config = config.Clone()
	config.NextProtos = []string{ALPNMulti}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, e := quic.DialAddr(ctx, address, config, ConfigMulti())
	if e != nil {
		t.Fatal(e)
	}
	s, e := conn.OpenStreamSync(ctx)
	if e != nil {
		t.Fatal(e)
	}
	_ = WriteFrame(s, laneHandshake("transport.open", 0))
	_ = s.SetReadDeadline(time.Now().Add(4 * time.Second))
	if _, e = ReadFrame(s); e == nil {
		t.Fatal("partial role set accepted")
	}
	_ = conn.CloseWithError(0, "")
	if upstream.Load() != 0 {
		t.Fatal("partial candidate reached upstream")
	}
}

func TestMultiAggregatedReadDrainsFinalControlAfterOtherLaneFIN(t *testing.T) {
	want := []byte(`{"final":"` + strings.Repeat("a", 1024*1024) + `"}`)
	address, config := multiAdapter(t, func(ws *websocket.Conn) { _ = ws.WriteMessage(websocket.TextMessage, want) })
	c := dialMultiTest(t, address, config)
	got, err := c.Read()
	if err != nil || string(got) != string(want) {
		t.Fatalf("final control lost when another stream ended: %v (%d bytes)", err, len(got))
	}
	if _, err = c.Read(); err != io.EOF {
		t.Fatalf("expected all lanes finished, got %v", err)
	}
}

func TestMultiCloseRacingFirstAggregateReadJoinsReaders(t *testing.T) {
	address, config := multiAdapter(t, func(ws *websocket.Conn) { _, _, _ = ws.ReadMessage() })
	for range 20 {
		c := dialMultiTest(t, address, config)
		done := make(chan struct{})
		go func() { _, _ = c.Read(); close(done) }()
		c.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("reader survived close")
		}
	}
}

// A bounded overload below the shared hard guard, with four independent connections.
// This checks progress and teardown, not a WAN latency or throughput claim.
func TestMultiSlowReadersKeepControlProgressAcrossConnections(t *testing.T) {
	var peers atomic.Int32
	var live atomic.Int32
	address, config := multiAdapter(t, func(ws *websocket.Conn) {
		peers.Add(1)
		live.Add(1)
		defer live.Add(-1)
		frame := []byte(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"bulk"},"ct":"` + strings.Repeat("a", 64*1024) + `"}}`)
		for range 96 {
			if ws.WriteMessage(websocket.TextMessage, frame) != nil {
				return
			}
		}
		for {
			kind, frame, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, frame) != nil {
				return
			}
		}
	})
	// The fixture accepts four connections; exercise all slots concurrently.
	clients := make([]*MultiClient, 4)
	for i := range clients {
		clients[i] = dialMultiTest(t, address, config)
	}
	var tasks sync.WaitGroup
	for _, client := range clients {
		tasks.Add(1)
		go func(c *MultiClient) {
			defer tasks.Done()
			for n := 0; n < 20; n++ {
				frame := laneFrame(0, n)
				if err := c.WriteLane(0, frame); err != nil {
					t.Error(err)
					return
				}
				_ = c.streams[0].SetReadDeadline(time.Now().Add(2 * time.Second))
				reply, err := c.ReadLane(0)
				if err != nil || string(reply) != string(frame) {
					t.Errorf("control stalled behind slow bulk: %v", err)
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
			// Every sealed bulk frame is still present and can drain in order.
			_ = c.streams[2].SetReadDeadline(time.Now().Add(5 * time.Second))
			for range 96 {
				if _, err := c.ReadLane(2); err != nil {
					t.Error(err)
					return
				}
			}
		}(client)
	}
	tasks.Wait()
	for _, client := range clients {
		client.Close()
	}
	until := time.Now().Add(time.Second)
	for live.Load() != 0 && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	if peers.Load() != 4 || live.Load() != 0 {
		t.Fatalf("connection leak: opened=%d live=%d", peers.Load(), live.Load())
	}
}

func TestMultiHandshakeRetiresQueuedPriorSessionFrames(t *testing.T) {
	address, config := multiAdapter(t, func(ws *websocket.Conn) {
		frame := []byte(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"bulk"},"ct":"` + strings.Repeat("a", 64*1024) + `"}}`)
		for range 96 {
			if ws.WriteMessage(websocket.TextMessage, frame) != nil {
				return
			}
		}
		if ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"v2.frame","envelope":{"hdr":{"k":"hs"},"ct":"hs2"}}`)) != nil {
			return
		}
		if ws.WriteMessage(websocket.TextMessage, laneFrame(2, 999)) != nil {
			return
		}
		_, _, _ = ws.ReadMessage()
	})
	c := dialMultiTest(t, address, config)
	if _, err := c.ReadLane(0); err != nil {
		t.Fatal(err)
	}
	_ = c.streams[2].SetReadDeadline(time.Now().Add(3 * time.Second))
	old := 0
	for {
		frame, err := c.ReadLane(2)
		if err != nil {
			t.Fatal(err)
		}
		if string(frame) == string(laneFrame(2, 999)) {
			break
		}
		old++
	}
	if old >= 96 {
		t.Fatal("adapter sent the entire old queue after HS2")
	}
}

// Keep the production 30-second write deadline: a short slow-reader probe
// cannot establish what happens when a stream remains blocked indefinitely.
func TestMultiStalledBulkDeadlineClosesPathAndAllowsReconnect(t *testing.T) {
	var peers, live atomic.Int32
	stalledUpstreamExited := make(chan struct{})
	address, config := multiAdapter(t, func(ws *websocket.Conn) {
		peer := peers.Add(1)
		live.Add(1)
		defer live.Add(-1)
		if peer == 1 {
			defer close(stalledUpstreamExited)
			frame := []byte(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"bulk"},"ct":"` + strings.Repeat("b", 64*1024) + `"}}`)
			for range 96 {
				if ws.WriteMessage(websocket.TextMessage, frame) != nil {
					return
				}
			}
		}
		for {
			kind, frame, err := ws.ReadMessage()
			if err != nil || ws.WriteMessage(kind, frame) != nil {
				return
			}
		}
	})
	c := dialMultiTest(t, address, config)
	start := time.Now()
	// Leave bulk unread while proving that ctl continues for most of the timeout.
	for n := 0; n < 20; n++ {
		want := laneFrame(0, n)
		if err := c.WriteLane(0, want); err != nil {
			t.Fatal(err)
		}
		_ = c.streams[0].SetReadDeadline(time.Now().Add(2 * time.Second))
		got, err := c.ReadLane(0)
		if err != nil || string(got) != string(want) {
			t.Fatalf("control failed before stalled-lane deadline: %v", err)
		}
		time.Sleep(time.Second)
	}
	select {
	case <-c.conn.Context().Done():
	case <-time.After(15 * time.Second):
		t.Fatal("stalled stream survived its production write deadline")
	}
	var applicationError *quic.ApplicationError
	if err := context.Cause(c.conn.Context()); !errors.As(err, &applicationError) || applicationError.ErrorCode != 7 {
		t.Fatalf("expected explicit stream-write failure, got %v", err)
	}
	if elapsed := time.Since(start); elapsed < 28*time.Second || elapsed > 35*time.Second {
		t.Fatalf("unexpected production deadline: %v", elapsed)
	}
	select {
	case <-stalledUpstreamExited:
	case <-time.After(time.Second):
		t.Fatal("upstream survived stalled-path closure")
	}
	c.Close()
	// Recovery opens a new connection explicitly; no automatic replay is involved.
	for n := 0; n < 12; n++ {
		replacement := dialMultiTest(t, address, config)
		want := laneFrame(0, 100+n)
		if err := replacement.WriteLane(0, want); err != nil {
			t.Fatal(err)
		}
		_ = replacement.streams[0].SetReadDeadline(time.Now().Add(2 * time.Second))
		got, err := replacement.ReadLane(0)
		if err != nil || string(got) != string(want) {
			t.Fatalf("reconnected control failed: %v", err)
		}
		replacement.Close()
	}
	until := time.Now().Add(time.Second)
	for live.Load() != 0 && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	if live.Load() != 0 || peers.Load() != 13 {
		t.Fatalf("connection cleanup mismatch: peers=%d live=%d", peers.Load(), live.Load())
	}
}

// History uses existing data frames on bulk only in the opt-in background policy.
// More history than stream credit is queued before live/state are produced.
func TestHistoryLaneIsolationComparedWithSharedMessages(t *testing.T) {
	for _, mode := range []string{"shared", "background"} {
		t.Run(mode, func(t *testing.T) {
			lane := 1
			if mode == "background" {
				lane = 2
			}
			const pages = 80
			history := make([][]byte, pages)
			for i := range history {
				history[i] = []byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":%q},"ct":%q}}`, laneNames[lane], fmt.Sprintf("history-%03d-", i)+strings.Repeat("h", 64*1024)))
			}
			live, state := laneFrame(1, 9001), laneFrame(0, 9002)
			queued := make(chan struct{})
			address, config := multiAdapter(t, func(ws *websocket.Conn) {
				for _, frame := range history {
					if ws.WriteMessage(websocket.TextMessage, frame) != nil {
						return
					}
				}
				for _, frame := range [][]byte{live, state} {
					if ws.WriteMessage(websocket.TextMessage, frame) != nil {
						return
					}
				}
				close(queued)
				_, _, _ = ws.ReadMessage()
			})
			c := dialMultiTest(t, address, config)
			select {
			case <-queued:
			case <-time.After(5 * time.Second):
				t.Fatal("history fixture did not queue all planned frames")
			}
			for _, stream := range c.streams {
				_ = stream.SetReadDeadline(time.Now().Add(5 * time.Second))
			}
			got, err := c.ReadLane(0)
			if err != nil || string(got) != string(state) {
				t.Fatalf("state: %v", err)
			}
			start := time.Now()
			if mode == "background" {
				got, err = c.ReadLane(1)
				if err != nil || string(got) != string(live) {
					t.Fatalf("live blocked behind unread history: %v", err)
				}
				t.Logf("live-before-history-read=true liveReadMs=%.3f historyFrames=%d", float64(time.Since(start).Microseconds())/1000, pages)
			}
			for i, want := range history {
				got, err = c.ReadLane(lane)
				if err != nil || string(got) != string(want) {
					t.Fatalf("history %d changed or out of order: %v", i, err)
				}
			}
			if mode == "shared" {
				got, err = c.ReadLane(1)
				if err != nil || string(got) != string(live) {
					t.Fatalf("shared live: %v", err)
				}
				t.Logf("live-before-history-read=false historyFramesBeforeLive=%d", pages)
			}
		})
	}
}
