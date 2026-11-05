// Package mobile is the minimal gomobile surface used by the Android App.
package mobile

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"github.com/WGooold/Orbis/native/relayquic"
	"sync"
	"time"
)

type Connection struct {
	mu                  sync.Mutex
	ctx                 context.Context
	cancel              context.CancelFunc
	address, serverName string
	rootsPEM            string
	client              *relayquic.MultiClient
	started, closed     bool
	five                bool
}

// rootsPEM comes from Android's default X509TrustManager, including platform CA updates.
func NewConnection(address, serverName, rootsPEM string) *Connection {
	ctx, cancel := context.WithCancel(context.Background())
	return &Connection{ctx: ctx, cancel: cancel, address: address, serverName: serverName, rootsPEM: rootsPEM}
}

func NewFiveConnection(address, serverName, rootsPEM string) *Connection {
	c := NewConnection(address, serverName, rootsPEM)
	c.five = true
	return c
}

// Open and Read block; Android calls them on IO workers, never the UI or OkHttp callback thread.
func (c *Connection) Open() error {
	c.mu.Lock()
	if c.started || c.closed {
		c.mu.Unlock()
		return errors.New("connection already opened or closed")
	}
	c.started = true
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 1500*time.Millisecond)
	defer cancel()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(c.rootsPEM)) {
		return errors.New("platform trust roots unavailable")
	}
	dial := relayquic.DialMulti
	if c.five {
		dial = relayquic.DialFive
	}
	client, err := dial(ctx, c.address, &tls.Config{ServerName: c.serverName, RootCAs: roots})
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		client.Close()
		return errors.New("connection closed")
	}
	c.client = client
	return nil
}

func (c *Connection) current() (*relayquic.MultiClient, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.client == nil {
		return nil, errors.New("connection not ready")
	}
	return c.client, nil
}
func (c *Connection) Read() ([]byte, error) {
	client, err := c.current()
	if err != nil {
		return nil, err
	}
	return client.Read()
}
func (c *Connection) Write(data []byte) error {
	client, err := c.current()
	if err != nil {
		return err
	}
	return client.Write(data)
}
func (c *Connection) ReadLane(lane int) ([]byte, error) {
	client, err := c.current()
	if err != nil {
		return nil, err
	}
	return client.ReadLane(lane)
}
func (c *Connection) WriteLane(lane int, data []byte) error {
	client, err := c.current()
	if err != nil {
		return err
	}
	return client.WriteLane(lane, data)
}
func (c *Connection) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.cancel()
	if c.client != nil {
		c.client.Close()
		c.client = nil
	}
}
