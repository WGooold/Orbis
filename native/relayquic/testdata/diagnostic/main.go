// Isolated continuous-byte TLS/QUIC baseline. No Relay or application protocol.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	mathrand "math/rand"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/WGooold/Orbis/native/relayquic/diagnostics"
	quic "github.com/quic-go/quic-go"
)

const alpn = "orbis-isolated-raw-diagnostic-v1"
const maxBytes = 1024 * 1024 * 1024

var pattern = func() []byte {
	b := make([]byte, 32*1024)
	_, _ = mathrand.New(mathrand.NewSource(91827)).Read(b)
	return b
}()

type config struct {
	Port  int      `json:"port"`
	IPs   []string `json:"ips"`
	Token string   `json:"token"`
}
type request struct {
	ID         string `json:"id"`
	Token      string `json:"token"`
	Direction  string `json:"direction"`
	WarmupMS   int    `json:"warmupMs"`
	DurationMS int    `json:"durationMs"`
}
type sample struct {
	ElapsedMS   int64                 `json:"elapsedMs"`
	Bytes       uint64                `json:"bytes"`
	WindowBytes uint64                `json:"windowBytes"`
	Stats       *quic.ConnectionStats `json:"stats,omitempty"`
}
type result struct {
	Type                string   `json:"type"`
	ID                  string   `json:"id"`
	Protocol            string   `json:"protocol"`
	Direction           string   `json:"direction"`
	Side                string   `json:"side"`
	Started             string   `json:"started"`
	WarmupMS            int      `json:"warmupMs"`
	DurationMS          int      `json:"durationMs"`
	MeasurementComplete bool     `json:"measurementComplete"`
	VerifiedBytes       uint64   `json:"verifiedBytes"`
	WindowBytes         uint64   `json:"windowBytes"`
	GoodputMbps         float64  `json:"goodputMbps"`
	WriteBytes          uint64   `json:"writeBytes"`
	WriteCalls          uint64   `json:"writeCalls"`
	WriteBlockedMS      float64  `json:"writeBlockedMs"`
	WriteMaxMS          float64  `json:"writeMaxMs"`
	Errors              []string `json:"errors"`
	SenderTermination   []string `json:"senderTermination,omitempty"`
	Samples             []sample `json:"samples"`
	Peer                *result  `json:"peer,omitempty"`
}
type stream interface {
	io.Reader
	io.Writer
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}
type endpoint struct {
	s     stream
	q     *quic.Conn
	close func()
}

func (e endpoint) stats() *quic.ConnectionStats {
	if e.q == nil {
		return nil
	}
	s := e.q.ConnectionStats()
	return &s
}

var outputMu sync.Mutex

func emit(v any) { outputMu.Lock(); defer outputMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, e := w.Write(b)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
func record(w io.Writer, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], uint32(len(b)))
	if e = writeAll(w, h[:]); e != nil {
		return e
	}
	return writeAll(w, b)
}
func readRecord(r io.Reader, v any) error {
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return e
	}
	n := binary.BigEndian.Uint32(h[:])
	if n == 0 || n > 1024*1024 {
		return errors.New("invalid control record")
	}
	b := make([]byte, n)
	if _, e := io.ReadFull(r, b); e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func verify(b []byte, offset uint64) bool {
	for len(b) > 0 {
		pos := int(offset % uint64(len(pattern)))
		n := min(len(b), len(pattern)-pos)
		if !bytes.Equal(b[:n], pattern[pos:pos+n]) {
			return false
		}
		b = b[n:]
		offset += uint64(n)
	}
	return true
}
func fresh(req request, proto, side string) result {
	return result{Type: "raw.result", ID: req.ID, Protocol: proto, Direction: req.Direction, Side: side, Started: time.Now().UTC().Format(time.RFC3339Nano), WarmupMS: req.WarmupMS, DurationMS: req.DurationMS, Errors: []string{}, Samples: []sample{}}
}
func receive(e endpoint, req request, proto, side string) result {
	r := fresh(req, proto, side)
	start := time.Now()
	begin := start.Add(time.Duration(req.WarmupMS) * time.Millisecond)
	end := begin.Add(time.Duration(req.DurationMS) * time.Millisecond)
	var total, measured atomic.Uint64
	stop := make(chan struct{})
	done := make(chan []sample, 1)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		samples := []sample{}
		for {
			select {
			case <-ticker.C:
				samples = append(samples, sample{time.Since(start).Milliseconds(), total.Load(), measured.Load(), e.stats()})
			case <-stop:
				done <- samples
				return
			}
		}
	}()
	_ = e.s.SetReadDeadline(end)
	b := make([]byte, 32*1024)
	for {
		n, err := e.s.Read(b)
		now := time.Now()
		if n > 0 {
			if !verify(b[:n], total.Load()) {
				r.Errors = append(r.Errors, "payload content mismatch")
				break
			}
			total.Add(uint64(n))
			if !now.Before(begin) && now.Before(end) {
				measured.Add(uint64(n))
			}
		}
		if !now.Before(end) {
			r.MeasurementComplete = true
			break
		}
		if err != nil {
			r.Errors = append(r.Errors, err.Error())
			break
		}
		if total.Load() >= maxBytes {
			r.Errors = append(r.Errors, "one GiB safety byte cap reached")
			break
		}
	}
	close(stop)
	r.Samples = <-done
	r.Samples = append(r.Samples, sample{time.Since(start).Milliseconds(), total.Load(), measured.Load(), e.stats()})
	r.VerifiedBytes = total.Load()
	r.WindowBytes = measured.Load()
	r.GoodputMbps = float64(r.WindowBytes) * 8 / (float64(req.DurationMS) / 1000) / 1e6
	return r
}
func send(e endpoint, req request, proto, side string) result {
	r := fresh(req, proto, side)
	start := time.Now()
	end := start.Add(time.Duration(req.WarmupMS+req.DurationMS+10000) * time.Millisecond)
	_ = e.s.SetWriteDeadline(end)
	last := start
	for r.WriteBytes < maxBytes {
		t0 := time.Now()
		n, err := e.s.Write(pattern)
		elapsed := time.Since(t0)
		r.WriteBytes += uint64(n)
		r.WriteCalls++
		r.WriteBlockedMS += float64(elapsed) / float64(time.Millisecond)
		r.WriteMaxMS = max(r.WriteMaxMS, float64(elapsed)/float64(time.Millisecond))
		if time.Since(last) >= time.Second {
			last = time.Now()
			r.Samples = append(r.Samples, sample{time.Since(start).Milliseconds(), r.WriteBytes, 0, e.stats()})
		}
		if err != nil {
			r.Errors = append(r.Errors, err.Error())
			break
		}
		if n != len(pattern) {
			r.Errors = append(r.Errors, io.ErrShortWrite.Error())
			break
		}
	}
	if r.WriteBytes >= maxBytes {
		r.Errors = append(r.Errors, "one GiB safety byte cap reached")
	}
	return r
}
func qc(path string) (*quic.Config, error) {
	c := &quic.Config{HandshakeIdleTimeout: 5 * time.Second, MaxIdleTimeout: 15 * time.Second, KeepAlivePeriod: 5 * time.Second, MaxIncomingStreams: 1, MaxIncomingUniStreams: -1, InitialStreamReceiveWindow: 256 * 1024, MaxStreamReceiveWindow: 4 * 1024 * 1024, InitialConnectionReceiveWindow: 1024 * 1024, MaxConnectionReceiveWindow: 12 * 1024 * 1024}
	return c, diagnostics.Configure(c, path)
}
func serveSession(e endpoint, proto, token string) {
	defer e.close()
	_ = e.s.SetReadDeadline(time.Now().Add(10 * time.Second))
	_ = e.s.SetWriteDeadline(time.Now().Add(10 * time.Second))
	var req request
	if readRecord(e.s, &req) != nil || subtle.ConstantTimeCompare([]byte(req.Token), []byte(token)) != 1 || req.DurationMS < 100 || req.DurationMS > 60000 || req.WarmupMS < 0 || req.WarmupMS > 10000 || (req.Direction != "upload" && req.Direction != "download") {
		return
	}
	if record(e.s, map[string]bool{"ready": true}) != nil {
		return
	}
	_ = e.s.SetReadDeadline(time.Time{})
	_ = e.s.SetWriteDeadline(time.Time{})
	if req.Direction == "upload" {
		r := receive(e, req, proto, "server-receiver")
		_ = e.s.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = record(e.s, r)
		emit(r)
		// Ensure QUIC delivers the result before CONNECTION_CLOSE.
		_ = e.s.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _ = io.Copy(io.Discard, e.s)
	} else {
		stopped := make(chan struct{})
		go func() { var stop map[string]bool; _ = readRecord(e.s, &stop); e.close(); close(stopped) }()
		r := send(e, req, proto, "server-sender")
		e.close()
		<-stopped
		emit(r)
	}
}
func server(ctx context.Context, metrics string) error {
	var cfg config
	if err := json.NewDecoder(os.Stdin).Decode(&cfg); err != nil {
		return err
	}
	if cfg.Port < 20000 || cfg.Port > 60000 || len(cfg.Token) != 64 {
		return errors.New("invalid server config")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(2 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, s := range cfg.IPs {
		ip := net.ParseIP(s)
		if ip == nil {
			return errors.New("invalid certificate IP")
		}
		cert.IPAddresses = append(cert.IPAddresses, ip)
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	tc := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13, NextProtos: []string{alpn}}
	address := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	qconfig, err := qc(metrics)
	if err != nil {
		return err
	}
	ql, err := quic.ListenAddr(address, tc, qconfig)
	if err != nil {
		return err
	}
	defer ql.Close()
	tl, err := tls.Listen("tcp", address, tc)
	if err != nil {
		return err
	}
	defer tl.Close()
	ctx, cancel := context.WithTimeout(ctx, 40*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	stop := context.AfterFunc(ctx, func() { _ = ql.Close(); _ = tl.Close() })
	defer stop()
	var workers sync.WaitGroup
	defer workers.Wait()
	tlsAcceptDone := make(chan struct{})
	go func() {
		defer close(tlsAcceptDone)
		for {
			c, err := tl.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				stop := context.AfterFunc(ctx, func() { _ = c.Close() })
				defer stop()
				serveSession(endpoint{s: c, close: func() { _ = c.Close() }}, "tls", cfg.Token)
			}()
		}
	}()
	defer func() { _ = tl.Close(); <-tlsAcceptDone }()
	emit(map[string]any{"type": "ready", "port": cfg.Port, "certificate": base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))})
	for {
		c, err := ql.Accept(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			stop := context.AfterFunc(ctx, func() { _ = c.CloseWithError(0, "fixture stopping") })
			defer stop()
			setup, end := context.WithTimeout(ctx, 10*time.Second)
			s, err := c.AcceptStream(setup)
			end()
			if err != nil {
				_ = c.CloseWithError(1, "setup failed")
				return
			}
			serveSession(endpoint{s: s, q: c, close: func() { _ = c.CloseWithError(0, "fixture completed") }}, "quic", cfg.Token)
		}()
	}
}
func client(ctx context.Context, address, caPath, token, metrics string, rounds int, warmup, duration time.Duration) error {
	cert, err := os.ReadFile(caPath)
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(cert) {
		return errors.New("invalid CA")
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	tc := &tls.Config{RootCAs: pool, ServerName: host, MinVersion: tls.VersionTLS13, NextProtos: []string{alpn}}
	failed := false
	for _, direction := range []string{"download", "upload"} {
		for round := 1; round <= rounds; round++ {
			protocols := []string{"tls", "quic"}
			if round%2 == 0 {
				protocols = []string{"quic", "tls"}
			}
			for _, proto := range protocols {
				req := request{ID: fmt.Sprintf("raw-%s-%02d-%s", direction, round, proto), Token: token, Direction: direction, WarmupMS: int(warmup.Milliseconds()), DurationMS: int(duration.Milliseconds())}
				fmt.Fprintf(os.Stderr, "START %s %s\n", req.ID, time.Now().UTC().Format(time.RFC3339))
				r := fresh(req, proto, "client")
				var e endpoint
				setup, end := context.WithTimeout(ctx, 10*time.Second)
				if proto == "quic" {
					conf, ce := qc(metrics)
					if ce != nil {
						return ce
					}
					c, ce := quic.DialAddr(setup, address, tc, conf)
					err = ce
					if err == nil {
						s, se := c.OpenStreamSync(setup)
						err = se
						if err == nil {
							e = endpoint{s: s, q: c, close: func() { _ = c.CloseWithError(0, "client complete") }}
						} else {
							_ = c.CloseWithError(1, "setup failed")
						}
					}
				} else {
					c, ce := (&tls.Dialer{Config: tc, NetDialer: &net.Dialer{Timeout: 10 * time.Second}}).DialContext(setup, "tcp", address)
					err = ce
					if err == nil {
						e = endpoint{s: c, close: func() { _ = c.Close() }}
					}
				}
				end()
				if err == nil {
					stop := context.AfterFunc(ctx, e.close)
					_ = e.s.SetWriteDeadline(time.Now().Add(10 * time.Second))
					err = record(e.s, req)
					_ = e.s.SetReadDeadline(time.Now().Add(10 * time.Second))
					var ready map[string]bool
					if err == nil {
						err = readRecord(e.s, &ready)
					}
					if err == nil && !ready["ready"] {
						err = errors.New("server not ready")
					}
					if err == nil {
						_ = e.s.SetReadDeadline(time.Time{})
						_ = e.s.SetWriteDeadline(time.Time{})
						if direction == "download" {
							r = receive(e, req, proto, "client-receiver")
							_ = record(e.s, map[string]bool{"stop": true})
						} else {
							sent := make(chan result, 1)
							go func() { sent <- send(e, req, proto, "client-sender") }()
							_ = e.s.SetReadDeadline(time.Now().Add(warmup + duration + 15*time.Second))
							var peer result
							err = readRecord(e.s, &peer)
							e.close()
							r = <-sent
							senderErrors := r.Errors
							r.Peer = &peer
							r.MeasurementComplete = peer.MeasurementComplete
							r.WindowBytes = peer.WindowBytes
							r.GoodputMbps = peer.GoodputMbps
							r.VerifiedBytes = peer.VerifiedBytes
							r.Errors = peer.Errors
							r.SenderTermination = senderErrors
							for _, sendError := range senderErrors {
								if sendError == "one GiB safety byte cap reached" {
									r.Errors = append(r.Errors, sendError)
								}
							}
						}
					}
					e.close()
					stop()
				}
				if err != nil {
					r.Errors = append(r.Errors, err.Error())
				}
				if !r.MeasurementComplete || len(r.Errors) > 0 {
					failed = true
				}
				emit(r)
				fmt.Fprintf(os.Stderr, "DONE %s Mbps=%.6f complete=%v errors=%v\n", req.ID, r.GoodputMbps, r.MeasurementComplete, r.Errors)
				if ctx.Err() != nil {
					return ctx.Err()
				}
			}
		}
	}
	if failed {
		return errors.New("one or more attempts failed")
	}
	return nil
}
func main() {
	role := flag.String("role", "client", "server or client")
	address := flag.String("address", "", "remote IP:port")
	ca := flag.String("ca", "", "isolated trust root")
	private := flag.String("private-config", "", "0600 config containing test token")
	metrics := flag.String("metrics", "", "metadata JSONL path")
	rounds := flag.Int("rounds", 5, "interleaved rounds")
	warmup := flag.Duration("warmup", 3*time.Second, "warmup")
	duration := flag.Duration("duration", 20*time.Second, "fixed receiver measurement")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	if *role == "server" {
		err = server(ctx, *metrics)
	} else {
		b, e := os.ReadFile(filepath.Clean(*private))
		if e != nil {
			err = e
		} else {
			var c config
			err = json.Unmarshal(b, &c)
			if err == nil {
				err = client(ctx, *address, *ca, c.Token, *metrics, *rounds, *warmup, *duration)
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
