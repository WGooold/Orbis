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

func TestHostAndDeviceALPNRouteToFixedEndpoints(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			upgrader := websocket.Upgrader{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ws, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer ws.Close()
				_ = ws.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"path":%q}`, r.URL.Path)))
				_, _, _ = ws.ReadMessage()
			}))
			defer upstream.Close()
			serverTLS, clientTLS := testTLS(t)
			serverTLS.NextProtos = []string{ALPNMulti, ALPNHostMulti}
			listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, ConfigMulti())
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			done := make(chan error, 1)
			base := "ws" + strings.TrimPrefix(upstream.URL, "http")
			runtime := ""
			if enabled {
				runtime = base + "/v1/runtime"
			}
			go func() { done <- ServeRoutes(ctx, listener, base+"/v1/device", runtime, 1) }()
			defer func() {
				cancel()
				if err := <-done; err != nil {
					t.Error(err)
				}
			}()
			host, err := DialHostMulti(ctx, listener.Addr().String(), clientTLS)
			if !enabled {
				if err == nil {
					host.Close()
					t.Fatal("disabled Host route accepted")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				defer host.Close()
				b, err := host.ReadLane(0)
				if err != nil || string(b) != `{"path":"/v1/runtime"}` {
					t.Fatalf("Host route: %s %v", b, err)
				}
				// Host and device consume the same admission budget.
				if extra, err := DialMulti(ctx, listener.Addr().String(), clientTLS); err == nil {
					extra.Close()
					t.Fatal("device bypassed shared connection limit")
				}
				return
			}
			device, err := DialMulti(ctx, listener.Addr().String(), clientTLS)
			if err != nil {
				t.Fatal(err)
			}
			defer device.Close()
			b, err := device.ReadLane(0)
			if err != nil || string(b) != `{"path":"/v1/device"}` {
				t.Fatalf("device route: %s %v", b, err)
			}
		})
	}
}

func TestRuntimeUpstreamCannotSelectOtherRoleOrRemote(t *testing.T) {
	for _, u := range []string{"ws://localhost/v1/runtime", "ws://example.com/v1/runtime", "ws://127.0.0.1/v1/device", "ws://127.0.0.1/v1/runtime?target=x"} {
		if ValidateRuntimeUpstream(u) == nil {
			t.Fatalf("accepted %s", u)
		}
	}
	if err := ValidateRuntimeUpstream("ws://127.0.0.1:8787/v1/runtime"); err != nil {
		t.Fatal(err)
	}
}

func TestHandshakeRetiresOnlyItsDeviceAndReleasesBudget(t *testing.T) {
	q := newFrameQueue()
	q.budget = &queueBudget{limit: 1024 * 1024}
	frame := func(from, to, kind, channel string) []byte {
		return []byte(fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"from":%q,"to":%q,"k":%q,"ch":%q}}}`, from, to, kind, channel))
	}
	other := frame("device-b", "host", "data", "bulk")
	for _, b := range [][]byte{frame("device-a", "host", "data", "bulk"), other, []byte(`{"type":"runtime.ready"}`)} {
		if err := q.push(b); err != nil {
			t.Fatal(err)
		}
	}
	q.retireBeforeHandshake(frame("device-a", "host", "hs", "ctl"))
	if q.count != 2 || q.bytes[2] != len(other) || q.budget.used.Load() != int64(len(other)+len(`{"type":"runtime.ready"}`)) {
		t.Fatalf("wrong device retired or budget leaked: %+v", q.bytes)
	}
	b, err := q.popLane(context.Background(), 2)
	if err != nil || string(b) != string(other) {
		t.Fatalf("other device lost: %v", err)
	}
	q.discard()
	if q.budget.used.Load() != 0 {
		t.Fatal("budget not released")
	}
}
