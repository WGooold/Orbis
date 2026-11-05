package relayquic

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testTLS(t *testing.T) (*tls.Config, *tls.Config) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	pair, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return &tls.Config{Certificates: []tls.Certificate{pair}, NextProtos: []string{ALPN}, MinVersion: tls.VersionTLS13}, &tls.Config{RootCAs: roots, ServerName: "localhost"}
}

func testAdapter(t *testing.T, handler func(*websocket.Conn)) (string, *tls.Config) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/device" {
			http.NotFound(w, r)
			return
		}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		handler(ws)
	}))
	t.Cleanup(upstream.Close)
	serverTLS, clientTLS := testTLS(t)
	listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, Config())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, "ws"+strings.TrimPrefix(upstream.URL, "http")+"/v1/device", 4) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("server did not stop all pumps")
		}
	})
	return listener.Addr().String(), clientTLS
}

func dialTest(t *testing.T, address string, config *tls.Config) *Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client, err := Dial(ctx, address, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return client
}

func TestNativeQUICRoundTrip(t *testing.T) {
	address, config := testAdapter(t, func(ws *websocket.Conn) {
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, data) != nil {
				return
			}
		}
	})
	client := dialTest(t, address, config)
	for n := 0; n < 50; n++ {
		frame := fmt.Sprintf(`{"seq":%d,"text":"你好"}`, n)
		if err := client.Write([]byte(frame)); err != nil {
			t.Fatal(err)
		}
		got, err := client.Read()
		if err != nil || string(got) != frame {
			t.Fatalf("round trip: %v", err)
		}
	}
}

func TestLastProtocolErrorSurvivesUpstreamClose(t *testing.T) {
	address, config := testAdapter(t, func(ws *websocket.Conn) {
		_, _, _ = ws.ReadMessage()
		_ = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"protocol.error","code":"invalid_credential"}`))
		_ = ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1008, "invalid_credential"), time.Now().Add(time.Second))
	})
	client := dialTest(t, address, config)
	_ = client.Write([]byte(`{"type":"device.authenticate","credential":"invalid"}`))
	data, err := client.Read()
	if err != nil || !strings.Contains(string(data), "invalid_credential") {
		t.Fatalf("lost final error: %s %v", data, err)
	}
}

func TestCertificateHostnameAndTrustAreEnforced(t *testing.T) {
	address, config := testAdapter(t, func(ws *websocket.Conn) { _, _, _ = ws.ReadMessage() })
	for _, wrong := range []*tls.Config{{ServerName: "localhost"}, {ServerName: "wrong.invalid", RootCAs: config.RootCAs}} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		client, err := Dial(ctx, address, wrong)
		cancel()
		if err == nil {
			client.Close()
			t.Fatal("accepted invalid TLS")
		}
	}
}

func TestCanceledDialDoesNotReturnLiveClient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c, err := Dial(ctx, "127.0.0.1:9", &tls.Config{ServerName: "localhost"}); err == nil {
		c.Close()
		t.Fatal("canceled dial succeeded")
	}
}

func TestOnlyFixedLoopbackDeviceUpstream(t *testing.T) {
	for _, u := range []string{"ws://example.com/v1/device", "ws://localhost/v1/device", "ws://127.0.0.1/v1/runtime", "ws://user@127.0.0.1/v1/device", "ws://127.0.0.1/v1/device?target=remote", "wss://127.0.0.1/v1/device"} {
		if ValidateUpstream(u) == nil {
			t.Fatalf("accepted %s", u)
		}
	}
	for _, u := range []string{"ws://127.0.0.1:8787/v1/device", "ws://[::1]:8787/v1/device"} {
		if err := ValidateUpstream(u); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSecondStreamCannotBypassSingleWriter(t *testing.T) {
	address, config := testAdapter(t, func(ws *websocket.Conn) { _, _, _ = ws.ReadMessage() })
	client := dialTest(t, address, config)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if stream, err := client.conn.OpenStreamSync(ctx); err == nil {
		stream.CancelWrite(1)
		t.Fatal("accepted a second stream")
	}
}

func TestMalformedTransportOpenNeverReachesUpstream(t *testing.T) {
	connected := make(chan struct{}, 1)
	address, config := testAdapter(t, func(ws *websocket.Conn) { connected <- struct{}{} })
	config = config.Clone()
	config.NextProtos = []string{ALPN}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, err := quic.DialAddr(ctx, address, config, Config())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseWithError(0, "")
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.SetDeadline(time.Now().Add(time.Second))
	_ = WriteFrame(stream, []byte(`{"type":"transport.open","version":2}`))
	if _, err = ReadFrame(stream); err == nil {
		t.Fatal("accepted unsupported version")
	}
	select {
	case <-connected:
		t.Fatal("invalid open reached Node Relay")
	default:
	}
}

func TestSlowReaderControlOvertakesUnwrittenBulk(t *testing.T) {
	sent := make(chan struct{})
	address, config := testAdapter(t, func(ws *websocket.Conn) {
		defer close(sent)
		for i := 0; i < 1024; i++ {
			frame := fmt.Sprintf(`{"type":"v2.frame","envelope":{"hdr":{"k":"piece","ch":"bulk","n":%d},"ct":%q}}`, i, strings.Repeat("a", 8192))
			if ws.WriteMessage(websocket.TextMessage, []byte(frame)) != nil {
				return
			}
		}
		_ = ws.WriteMessage(websocket.TextMessage, []byte(`{"type":"control-marker"}`))
		_, _, _ = ws.ReadMessage()
	})
	client := dialTest(t, address, config)
	// Do not read while the application queue fills and the QUIC receive window closes.
	time.Sleep(150 * time.Millisecond)
	_ = client.stream.SetReadDeadline(time.Now().Add(5 * time.Second))
	bulk := 0
	for {
		frame, err := client.Read()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(frame), "control-marker") {
			break
		}
		bulk++
	}
	if bulk >= 1024 {
		t.Fatal("control remained behind the entire bulk transfer")
	}
	// Retain every bulk frame after priority reordering.
	for bulk < 1024 {
		if _, err := client.Read(); err != nil {
			t.Fatal(err)
		}
		bulk++
	}
	client.Close()
}
