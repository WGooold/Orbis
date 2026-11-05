package relayquic

import (
	"context"
	"errors"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
	"net"
	"net/url"
	"sync"
	"time"
)

// ValidateUpstream restricts the adapter to the local device endpoint. No target comes from clients.
func ValidateUpstream(raw string) error {
	return validateUpstream(raw, "/v1/device")
}

func ValidateRuntimeUpstream(raw string) error {
	return validateUpstream(raw, "/v1/runtime")
}

func validateUpstream(raw, path string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid upstream")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "ws" || ip == nil || !ip.IsLoopback() || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != path {
		return errors.New("upstream must be ws://loopback:port" + path)
	}
	return nil
}

// Serve returns after all accepted connections and their pump goroutines have stopped.
func Serve(ctx context.Context, listener *quic.Listener, upstream string, limit int) error {
	return ServeRoutes(ctx, listener, upstream, "", limit)
}

// ServeRoutes shares admission and queue budgets across both authenticated roles.
// Only ALPN chooses the fixed configured route, never a client-provided URL.
func ServeRoutes(ctx context.Context, listener *quic.Listener, upstream, runtimeUpstream string, limit int) error {
	if err := ValidateUpstream(upstream); err != nil {
		return err
	}
	if runtimeUpstream != "" {
		if err := ValidateRuntimeUpstream(runtimeUpstream); err != nil {
			return err
		}
	}
	if limit < 1 {
		return errors.New("connection limit must be positive")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	budget := &queueBudget{limit: 128 * 1024 * 1024}
	slots := make(chan struct{}, limit)
	var workers sync.WaitGroup
	defer workers.Wait()
	for {
		conn, err := listener.Accept(ctx)
		if err != nil {
			canceled := ctx.Err() != nil
			cancel()
			if canceled {
				return nil
			}
			return err
		}
		target := upstream
		if conn.ConnectionState().TLS.NegotiatedProtocol == ALPNHostMulti || conn.ConnectionState().TLS.NegotiatedProtocol == ALPNHostFive {
			if runtimeUpstream == "" {
				_ = conn.CloseWithError(3, "host role disabled")
				continue
			}
			target = runtimeUpstream
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
			go func() { defer workers.Done(); defer func() { <-slots }(); serveConnection(ctx, conn, target, budget) }()
		default:
			_ = conn.CloseWithError(2, "capacity reached")
		}
	}
}

func serveConnection(ctx context.Context, conn *quic.Conn, upstream string, budget *queueBudget) {
	if alpn := conn.ConnectionState().TLS.NegotiatedProtocol; alpn == ALPNMulti || alpn == ALPNHostMulti || alpn == ALPNFive || alpn == ALPNHostFive {
		serveMultiConnection(ctx, conn, upstream, budget)
		return
	}
	defer conn.CloseWithError(0, "closed")
	stop := context.AfterFunc(ctx, func() { _ = conn.CloseWithError(0, "server stopping") })
	defer stop()
	setup, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	stream, err := conn.AcceptStream(setup)
	if err != nil {
		return
	}
	_ = stream.SetDeadline(time.Now().Add(3 * time.Second))
	open, err := ReadFrame(stream)
	if err != nil || !handshakeFrame(open, "transport.open") {
		_ = conn.CloseWithError(3, "invalid transport open")
		return
	}
	dialer := websocket.Dialer{HandshakeTimeout: 1500 * time.Millisecond}
	ws, response, err := dialer.DialContext(setup, upstream, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		_ = conn.CloseWithError(4, "upstream unavailable")
		return
	}
	defer ws.Close()
	ws.SetReadLimit(MaxFrameSize)
	if err = WriteFrame(stream, []byte(`{"type":"transport.ready","version":1}`)); err != nil {
		return
	}
	_ = stream.SetDeadline(time.Time{})
	var pumps sync.WaitGroup
	pumps.Add(3)
	forwardCtx, forwardCancel := context.WithCancel(ctx)
	defer forwardCancel()
	outbound := newFrameQueue()
	outbound.budget = budget
	defer outbound.discard()
	done := make(chan bool, 2)
	go func() {
		defer pumps.Done()
		defer func() { done <- false }()
		for {
			frame, err := ReadFrame(stream)
			if err != nil {
				return
			}
			_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if ws.WriteMessage(websocket.TextMessage, frame) != nil {
				return
			}
		}
	}()
	go func() {
		defer pumps.Done()
		defer outbound.finish()
		for {
			kind, frame, err := ws.ReadMessage()
			if err != nil || kind != websocket.TextMessage {
				return
			}
			if !validFrame(frame) || outbound.push(frame) != nil {
				_ = conn.CloseWithError(5, "invalid or excessive upstream frames")
				return
			}
		}
	}()
	go func() {
		defer pumps.Done()
		defer func() { _ = stream.Close(); done <- true }()
		for {
			frame, err := outbound.pop(forwardCtx)
			if err != nil {
				return
			}
			_ = stream.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if WriteFrame(stream, frame) != nil {
				return
			}
		}
	}()
	select {
	case graceful := <-done:
		if graceful {
			// FIN follows all pending response bytes. Give the peer time to read them and
			// close, rather than discarding a final protocol.error with CONNECTION_CLOSE.
			timer := time.NewTimer(3 * time.Second)
			select {
			case <-conn.Context().Done():
			case <-ctx.Done():
			case <-timer.C:
			}
			timer.Stop()
		}
	case <-ctx.Done():
	case <-conn.Context().Done():
	}
	_ = ws.Close()
	forwardCancel()
	_ = conn.CloseWithError(0, "relay disconnected")
	pumps.Wait()
}
