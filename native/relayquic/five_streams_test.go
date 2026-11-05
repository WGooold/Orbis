package relayquic

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

func TestFiveStreamsPreserveRolesFIFOAndLegacyConnections(t *testing.T) {
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			kind, b, e := ws.ReadMessage()
			if e != nil {
				return
			}
			if ws.WriteMessage(kind, b) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	serverTLS, clientTLS := testTLS(t)
	serverTLS.NextProtos = []string{ALPNFive, ALPNHostFive, ALPNMulti, ALPNHostMulti}
	listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, ConfigFive())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	base := "ws" + strings.TrimPrefix(upstream.URL, "http")
	go func() { done <- ServeRoutes(ctx, listener, base+"/v1/device", base+"/v1/runtime", 4) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	for _, host := range []bool{false, true} {
		dial := DialFive
		if host {
			dial = DialHostFive
		}
		c, e := dial(ctx, listener.Addr().String(), clientTLS)
		if e != nil {
			t.Fatal(e)
		}
		for _, lane := range []int{2, 4, 3, 1, 0} {
			for n := 0; n < 3; n++ {
				if err := c.WriteLane(lane, laneFrame(lane, n)); err != nil {
					t.Fatal(err)
				}
			}
		}
		// Read high-urgency lanes first, independently of the earlier low lanes.
		for _, lane := range []int{0, 1, 3, 4, 2} {
			for n := 0; n < 3; n++ {
				b, e := c.ReadLane(lane)
				if e != nil || string(b) != string(laneFrame(lane, n)) {
					t.Fatalf("lane=%d n=%d: %s %v", lane, n, b, e)
				}
			}
		}
		if c.WriteLane(3, laneFrame(4, 99)) == nil {
			t.Fatal("accepted mismatched role")
		}
		c.Close()
	}
	legacy, e := DialMulti(ctx, listener.Addr().String(), clientTLS)
	if e != nil {
		t.Fatal(e)
	}
	defer legacy.Close()
	if legacy.WriteLane(3, laneFrame(3, 1)) == nil {
		t.Fatal("legacy stream set accepted history")
	}
	if e := legacy.WriteLane(1, laneFrame(1, 42)); e != nil {
		t.Fatal(e)
	}
	b, e := legacy.ReadLane(1)
	if e != nil || string(b) != string(laneFrame(1, 42)) {
		t.Fatal("legacy msg changed", e)
	}
	extra, e := legacy.conn.OpenStreamSync(ctx)
	if e != nil {
		t.Fatal(e)
	}
	_ = WriteFrame(extra, laneHandshake("transport.open", 2))
	select {
	case <-legacy.conn.Context().Done():
	case <-time.After(2 * time.Second):
		t.Fatal("v2 acquired an unnegotiated fourth stream on a v3 listener")
	}
}

func TestHistoryCatchupQueuesShareOriginalSessionBudgetAndRetireOnHandshake(t *testing.T) {
	q := newFrameQueue()
	q.budget = &queueBudget{limit: 128 * 1024 * 1024}
	for _, lane := range []int{2, 4, 3, 1, 0} {
		if err := q.push(laneFrame(lane, lane)); err != nil {
			t.Fatal(err)
		}
	}
	for _, lane := range []int{0, 1, 3, 4, 2} {
		b, e := q.pop(context.Background())
		if e != nil || string(b) != string(laneFrame(lane, lane)) {
			t.Fatal("wrong delivery priority", lane, e)
		}
	}
	if q.budget.used.Load() != 0 {
		t.Fatal("budget leaked")
	}
	q.bytes[1] = queueByteLimits[1]
	if q.push(laneFrame(3, 1)) != ErrQueueCapacity || q.push(laneFrame(4, 1)) != ErrQueueCapacity {
		t.Fatal("new lanes expanded session budget")
	}
	q.bytes[1] = 0
	for _, ch := range []string{"history", "catchup"} {
		if e := q.push([]byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":%q,"from":"h","to":"d"}}}`, ch))); e != nil {
			t.Fatal(e)
		}
	}
	q.retireBeforeHandshake([]byte(`{"type":"v2.frame","envelope":{"hdr":{"k":"hs","from":"h","to":"d"}}}`))
	if q.count != 0 || q.budget.used.Load() != 0 {
		t.Fatal("old history/catchup survived handshake")
	}
}
