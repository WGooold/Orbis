package relayquic

import (
	"context"
	"crypto/tls"
	"errors"
	quic "github.com/quic-go/quic-go"
	"sync"
	"time"
)

func Config() *quic.Config {
	return &quic.Config{
		HandshakeIdleTimeout: 1500 * time.Millisecond,
		MaxIdleTimeout:       30 * time.Second, KeepAlivePeriod: 10 * time.Second,
		MaxIncomingStreams: 1, MaxIncomingUniStreams: -1,
		RequireStreamCreditRelease: true,
		InitialStreamReceiveWindow: 64 * 1024, MaxStreamReceiveWindow: 256 * 1024,
		InitialConnectionReceiveWindow: 64 * 1024, MaxConnectionReceiveWindow: 256 * 1024,
	}
}

type Client struct {
	conn    *quic.Conn
	stream  *quic.Stream
	writeMu sync.Mutex
}

// Dial returns only after the upstream Relay transport is ready. It never sends credentials.
func Dial(ctx context.Context, address string, tlsConfig *tls.Config) (*Client, error) {
	tlsConfig = tlsConfig.Clone()
	tlsConfig.NextProtos = []string{ALPN}
	tlsConfig.MinVersion = tls.VersionTLS13
	conn, err := quic.DialAddr(ctx, address, tlsConfig, Config())
	if err != nil {
		return nil, err
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = conn.CloseWithError(1, "transport setup failed")
		}
	}()
	stop := context.AfterFunc(ctx, func() { _ = conn.CloseWithError(1, "transport setup canceled") })
	defer stop()
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = stream.SetDeadline(deadline)
	}
	if err = WriteFrame(stream, []byte(`{"type":"transport.open","version":1}`)); err != nil {
		return nil, err
	}
	ready, err := ReadFrame(stream)
	if err != nil {
		return nil, err
	}
	if !handshakeFrame(ready, "transport.ready") {
		return nil, errors.New("invalid transport ready")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	_ = stream.SetDeadline(time.Time{})
	succeeded = true
	return &Client{conn: conn, stream: stream}, nil
}

func (c *Client) Read() ([]byte, error) {
	data, err := ReadFrame(c.stream)
	if err != nil {
		c.Close()
	}
	return data, err
}
func (c *Client) Write(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.stream.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return WriteFrame(c.stream, data)
}
func (c *Client) Close() { _ = c.conn.CloseWithError(0, "closed") }
