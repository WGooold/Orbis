package relayquic

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/WGooold/Orbis/native/relayquic/diagnostics"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

const ALPNMulti = "orbis-relay-v2"
const ALPNHostMulti = "orbis-relay-host-v2"
const ALPNFive = "orbis-relay-v3"
const ALPNHostFive = "orbis-relay-host-v3"

var laneNames = [5]string{"ctl", "msg", "bulk", "history", "catchup"}

func streamVersion(alpn string) int {
	if alpn == ALPNFive || alpn == ALPNHostFive {
		return 3
	}
	return 2
}
func streamCount(version int) int {
	if version == 3 {
		return 5
	}
	return 3
}
func ConfigFive() *quic.Config { c := ConfigMulti(); c.MaxIncomingStreams = 5; return c }

func ConfigMulti() *quic.Config {
	c := Config()
	c.MaxIncomingStreams = 3
	c.InitialStreamReceiveWindow = 256 * 1024
	c.MaxStreamReceiveWindow = 4 * 1024 * 1024
	c.InitialConnectionReceiveWindow = 1024 * 1024
	c.MaxConnectionReceiveWindow = 12 * 1024 * 1024
	return c
}

func laneHandshake(kind string, lane int) []byte { return laneHandshakeVersion(kind, lane, 2) }
func laneHandshakeVersion(kind string, lane, version int) []byte {
	b, _ := json.Marshal(map[string]any{"type": kind, "version": version, "lane": laneNames[lane]})
	return b
}

func handshakeLane(b []byte, kind string) (int, error) { return handshakeLaneVersion(b, kind, 2) }
func handshakeLaneVersion(b []byte, kind string, version int) (int, error) {
	var object map[string]json.RawMessage
	var t, lane string
	var v int
	if json.Unmarshal(b, &object) != nil || len(object) != 3 ||
		json.Unmarshal(object["type"], &t) != nil || t != kind ||
		json.Unmarshal(object["version"], &v) != nil || v != version ||
		json.Unmarshal(object["lane"], &lane) != nil {
		return 0, ErrFrame
	}
	for i, name := range laneNames[:streamCount(version)] {
		if lane == name {
			return i, nil
		}
	}
	return 0, ErrFrame
}

func prioritize(stream *quic.Stream, lane, version int) {
	urgency := [5]int8{0, 3, 7, 3, 5}
	if version == 3 {
		urgency[1] = 2
	}
	stream.SetPriority(urgency[lane], lane != 0)
}

// MultiClient owns the negotiated streams of one connection. ReadLane/WriteLane are FIFO
// per lane; callers may use separate workers for each lane. No business retry.
type MultiClient struct {
	conn         *quic.Conn
	streams      []*quic.Stream
	writeMu      []sync.Mutex
	readMu       []sync.Mutex
	merged       *frameQueue
	readers      sync.WaitGroup
	startReaders sync.Once
	lifecycle    sync.Mutex
	closed       bool
	closeOnce    sync.Once
	meter        *diagnostics.WriterMeter
	ctx          context.Context
	cancel       context.CancelFunc
}

func DialMulti(ctx context.Context, address string, tlsConfig *tls.Config) (*MultiClient, error) {
	return dialMulti(ctx, address, tlsConfig, ALPNMulti)
}

// DialHostMulti uses a distinct ALPN: a Host can never accidentally authenticate
// against the device endpoint of an older, device-only adapter.
func DialHostMulti(ctx context.Context, address string, tlsConfig *tls.Config) (*MultiClient, error) {
	return dialMulti(ctx, address, tlsConfig, ALPNHostMulti)
}

func DialFive(ctx context.Context, address string, tlsConfig *tls.Config) (*MultiClient, error) {
	return dialMulti(ctx, address, tlsConfig, ALPNFive)
}
func DialHostFive(ctx context.Context, address string, tlsConfig *tls.Config) (*MultiClient, error) {
	return dialMulti(ctx, address, tlsConfig, ALPNHostFive)
}

func dialMulti(ctx context.Context, address string, tlsConfig *tls.Config, alpn string) (*MultiClient, error) {
	version := streamVersion(alpn)
	count := streamCount(version)
	tlsConfig = tlsConfig.Clone()
	tlsConfig.NextProtos = []string{alpn}
	tlsConfig.MinVersion = tls.VersionTLS13
	clientConfig := ConfigMulti()
	if version == 3 {
		clientConfig = ConfigFive()
	}
	clientConfig.MaxIncomingStreams = -1
	if err := diagnostics.Configure(clientConfig, os.Getenv("ORBIS_QUIC_DIAGNOSTICS_FILE")); err != nil {
		return nil, err
	}
	conn, err := quic.DialAddr(ctx, address, tlsConfig, clientConfig)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithCancel(context.Background())
	c := &MultiClient{conn: conn, ctx: cctx, cancel: cancel, merged: newFrameQueue(), streams: make([]*quic.Stream, count), writeMu: make([]sync.Mutex, count), readMu: make([]sync.Mutex, count)}
	success := false
	defer func() {
		if !success {
			c.Close()
		}
	}()
	c.meter, err = diagnostics.NewWriterMeter(os.Getenv("ORBIS_QUIC_DIAGNOSTICS_FILE"), alpn+":"+conn.LocalAddr().String()+"->"+conn.RemoteAddr().String())
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.CloseWithError(1, "setup canceled") })
	defer stop()
	// Open all roles before waiting for ready. Server never upgrades WS for a
	// partial/duplicate role set and no credentials are sent during preparation.
	for lane := range c.streams {
		stream, err := conn.OpenStreamSync(ctx)
		if err != nil {
			return nil, err
		}
		c.streams[lane] = stream
		prioritize(stream, lane, version)
		if deadline, ok := ctx.Deadline(); ok {
			_ = stream.SetDeadline(deadline)
		}
		if err = WriteFrame(stream, laneHandshakeVersion("transport.open", lane, version)); err != nil {
			return nil, err
		}
	}
	for lane, stream := range c.streams {
		b, err := ReadFrame(stream)
		if err != nil {
			return nil, err
		}
		role, err := handshakeLaneVersion(b, "transport.ready", version)
		if err != nil || role != lane {
			return nil, ErrFrame
		}
		_ = stream.SetDeadline(time.Time{})
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	success = true
	return c, nil
}

// ConnectionStats exposes read-only transport metadata for isolated diagnostics.
func (c *MultiClient) ConnectionStats() quic.ConnectionStats { return c.conn.ConnectionStats() }

func (c *MultiClient) ReadLane(lane int) ([]byte, error) {
	if lane < 0 || lane >= len(c.streams) {
		return nil, ErrFrame
	}
	c.readMu[lane].Lock()
	defer c.readMu[lane].Unlock()
	b, err := ReadFrame(c.streams[lane])
	if err == nil {
		role, e := frameLane(b)
		if e != nil || role != lane {
			err = ErrFrame
		}
	}
	return b, err
}
func (c *MultiClient) WriteLane(lane int, b []byte) error {
	role, err := frameLane(b)
	if lane < 0 || lane >= len(c.streams) || err != nil || role != lane {
		return ErrFrame
	}
	c.writeMu[lane].Lock()
	defer c.writeMu[lane].Unlock()
	_ = c.streams[lane].SetWriteDeadline(time.Now().Add(30 * time.Second))
	if c.meter != nil {
		start := time.Now()
		err = WriteFrame(c.streams[lane], b)
		c.meter.ObserveLane(lane, len(b), time.Since(start), nil)
	} else {
		err = WriteFrame(c.streams[lane], b)
	}
	if err != nil {
		c.abort()
	}
	return err
}
func (c *MultiClient) Write(b []byte) error {
	lane, err := frameLane(b)
	if err != nil {
		return err
	}
	return c.WriteLane(lane, b)
}

// Read is for existing integration fixtures. Production mobile uses ReadLane.
// Consumers must not mix Read with ReadLane on the same connection.
func (c *MultiClient) Read() ([]byte, error) {
	c.lifecycle.Lock()
	if c.closed {
		c.lifecycle.Unlock()
		return nil, io.ErrClosedPipe
	}
	c.startReaders.Do(func() {
		var remaining atomic.Int32
		remaining.Store(int32(len(c.streams)))
		c.readers.Add(len(c.streams))
		for lane := range c.streams {
			go func(lane int) {
				defer c.readers.Done()
				defer func() {
					if remaining.Add(-1) == 0 {
						c.merged.finish()
					}
				}()
				for {
					b, err := c.ReadLane(lane)
					if err != nil {
						if !errors.Is(err, io.EOF) {
							c.abort()
						}
						return
					}
					if c.merged.push(b) != nil {
						c.abort()
						return
					}
				}
			}(lane)
		}
	})
	c.lifecycle.Unlock()
	return c.merged.pop(c.ctx)
}
func (c *MultiClient) abort() {
	c.closeOnce.Do(func() { c.cancel(); _ = c.conn.CloseWithError(0, "closed") })
}
func (c *MultiClient) Close() {
	c.lifecycle.Lock()
	c.closed = true
	c.lifecycle.Unlock()
	c.abort()
	c.readers.Wait()
	if c.meter != nil {
		for lane := range c.writeMu {
			c.writeMu[lane].Lock()
		}
		c.meter.Close()
		for lane := range c.writeMu {
			c.writeMu[lane].Unlock()
		}
	}
	c.merged.discard()
}

// One independent FIFO for each QUIC writer. The three send streams perform
// scheduling in quic-go; this queue never selects a different lane to send.
func (q *frameQueue) popLane(ctx context.Context, lane int) ([]byte, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		q.mu.Lock()
		if len(q.lanes[lane]) > 0 {
			b := q.lanes[lane][0]
			q.lanes[lane][0] = nil
			q.lanes[lane] = q.lanes[lane][1:]
			q.bytes[lane] -= len(b)
			q.budget.release(len(b))
			q.count--
			q.mu.Unlock()
			return b, nil
		}
		ended := q.finished
		wake := q.changed
		q.mu.Unlock()
		if ended {
			return nil, io.EOF
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wake:
		}
	}
}

func serveMultiConnection(ctx context.Context, conn *quic.Conn, upstream string, budget *queueBudget) {
	defer conn.CloseWithError(0, "closed")
	meter, err := diagnostics.NewWriterMeter(os.Getenv("ORBIS_QUIC_DIAGNOSTICS_FILE"), conn.ConnectionState().TLS.NegotiatedProtocol+":"+conn.RemoteAddr().String())
	if err != nil {
		return
	}
	defer meter.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.CloseWithError(0, "server stopping") })
	defer stop()
	setup, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	version := streamVersion(conn.ConnectionState().TLS.NegotiatedProtocol)
	streams := make([]*quic.Stream, streamCount(version))
	for range streams {
		stream, err := conn.AcceptStream(setup)
		if err != nil {
			return
		}
		_ = stream.SetDeadline(deadline(setup))
		b, err := ReadFrame(stream)
		if err != nil {
			return
		}
		lane, err := handshakeLaneVersion(b, "transport.open", version)
		if err != nil || streams[lane] != nil {
			_ = conn.CloseWithError(3, "invalid stream role")
			return
		}
		streams[lane] = stream
		prioritize(stream, lane, version)
	}
	ws, response, err := (&websocket.Dialer{HandshakeTimeout: 1500 * time.Millisecond}).DialContext(setup, upstream, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		_ = conn.CloseWithError(4, "upstream unavailable")
		return
	}
	defer ws.Close()
	ws.SetReadLimit(MaxFrameSize)
	for lane, stream := range streams {
		if WriteFrame(stream, laneHandshakeVersion("transport.ready", lane, version)) != nil {
			return
		}
		_ = stream.SetDeadline(time.Time{})
	}
	forward, cancelForward := context.WithCancel(ctx)
	defer cancelForward()
	inbound, outbound := newFrameQueue(), newFrameQueue()
	inbound.budget = budget
	outbound.budget = budget
	defer inbound.discard()
	defer outbound.discard()
	var pumps sync.WaitGroup
	failed := make(chan struct{}, 2*len(streams)+2)
	finished := make(chan struct{}, len(streams))
	fail := func() {
		select {
		case failed <- struct{}{}:
		default:
		}
	}
	pumps.Add(2*len(streams) + 3)
	// A v3 listener permits five streams at the QUIC layer. A legacy v2 peer
	// must still be confined to its negotiated three-role set.
	go func() {
		defer pumps.Done()
		if extra, err := conn.AcceptStream(forward); err == nil {
			extra.CancelRead(5)
			_ = conn.CloseWithError(5, "unexpected additional stream")
			fail()
		}
	}()
	// Reader tasks cannot block a different stream on local queue capacity.
	// Overflow closes the path instead of dropping sealed frames.
	for lane, stream := range streams {
		go func(lane int, s *quic.Stream) {
			defer pumps.Done()
			defer fail()
			for {
				b, e := ReadFrame(s)
				if e != nil {
					return
				}
				role, e := frameLane(b)
				if e != nil || role != lane {
					_ = conn.CloseWithError(5, "invalid frame lane")
					return
				}
				if e = inbound.push(b); e != nil {
					_ = conn.CloseWithError(6, e.Error())
					return
				}
			}
		}(lane, stream)
		go func(lane int, s *quic.Stream) {
			defer pumps.Done()
			for {
				b, e := outbound.popLane(forward, lane)
				if e != nil {
					if errors.Is(e, io.EOF) {
						_ = s.Close()
						finished <- struct{}{}
					} else {
						fail()
					}
					return
				}
				_ = s.SetWriteDeadline(time.Now().Add(30 * time.Second))
				var writeErr error
				if meter != nil {
					start := time.Now()
					writeErr = WriteFrame(s, b)
					outbound.mu.Lock()
					queued := outbound.bytes
					outbound.mu.Unlock()
					meter.ObserveLane(lane, len(b), time.Since(start), queued[:])
				} else {
					writeErr = WriteFrame(s, b)
				}
				if writeErr != nil {
					_ = conn.CloseWithError(7, "stream write failed or timed out")
					fail()
					return
				}
			}
		}(lane, stream)
	}
	go func() {
		defer pumps.Done()
		defer fail()
		for {
			b, e := inbound.pop(forward)
			if e != nil {
				return
			}
			_ = ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if ws.WriteMessage(websocket.TextMessage, b) != nil {
				return
			}
		}
	}()
	go func() {
		defer pumps.Done()
		defer outbound.finish()
		for {
			kind, b, e := ws.ReadMessage()
			if e != nil {
				return
			}
			role, laneErr := frameLane(b)
			if kind != websocket.TextMessage || !validFrame(b) || laneErr != nil || role >= len(streams) {
				_ = conn.CloseWithError(5, "invalid upstream frame")
				fail()
				return
			}
			outbound.retireBeforeHandshake(b)
			if e = outbound.push(b); e != nil {
				_ = conn.CloseWithError(6, e.Error())
				fail()
				return
			}
		}
	}()
	finishedCount := 0
	for finishedCount < len(streams) {
		select {
		case <-finished:
			finishedCount++
		case <-failed:
			goto cleanup
		case <-ctx.Done():
			goto cleanup
		case <-conn.Context().Done():
			goto cleanup
		}
	}
	// Preserve a final protocol.error: FIN each stream, then bounded graceful close.
	select {
	case <-conn.Context().Done():
	case <-ctx.Done():
	case <-time.After(3 * time.Second):
	}
cleanup:
	cancelForward()
	_ = ws.Close()
	_ = conn.CloseWithError(0, "relay disconnected")
	pumps.Wait()
}

func deadline(ctx context.Context) time.Time { value, _ := ctx.Deadline(); return value }
