// Performance harness for the actual Relay + native QUIC adapter. It does not
// use the WS-to-QUIC business test bridge and does not change production config.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/WGooold/Orbis/native/relayquic"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

var lanes = [3]string{"ctl", "msg", "bulk"}

type header struct {
	K    string `json:"k"`
	Room string `json:"room"`
	From string `json:"from"`
	To   string `json:"to"`
	N    uint64 `json:"n"`
	Ch   string `json:"ch"`
	IK   string `json:"ik,omitempty"`
	Mid  string `json:"mid,omitempty"`
	Idx  *int   `json:"idx,omitempty"`
	Last *bool  `json:"last,omitempty"`
}
type envelope struct {
	V   int    `json:"v"`
	Hdr header `json:"hdr"`
	CT  string `json:"ct"`
}
type frame struct {
	Type     string   `json:"type"`
	Version  int      `json:"protocolVersion"`
	Envelope envelope `json:"envelope"`
}
type metadata struct {
	Upstream, Credential, HostKey, DeviceKey, Payload string
	Version, WindowChunks                             int
	Remote                                            bool
	CAFile, HostTransport                             string
	QuicPort                                          int
}
type probe struct {
	ID          int      `json:"id"`
	ScheduledMS float64  `json:"scheduledMs"`
	SendDelayMS float64  `json:"sendDelayMs"`
	RTTMS       *float64 `json:"rttMs"`
	Error       string   `json:"error,omitempty"`
}
type result struct {
	Workload             string           `json:"workload"`
	MeasurementStarted   bool             `json:"measurementStarted"`
	MeasurementComplete  bool             `json:"measurementComplete"`
	WindowTransportBytes [3]uint64        `json:"windowTransportBytes"`
	Progress             []progressSample `json:"progress,omitempty"`
	HostProtocol         string           `json:"hostProtocol"`
	RemoteEndpoint       string           `json:"remoteEndpoint,omitempty"`
	Protocol             string           `json:"protocol"`
	Scenario             string           `json:"scenario"`
	Round                int              `json:"round"`
	Started              string           `json:"started"`
	WarmupSeconds        float64          `json:"warmupSeconds"`
	Seconds              float64          `json:"seconds"`
	DrainSeconds         float64          `json:"drainSeconds"`
	ChunkBytes           int              `json:"chunkBytes"`
	WindowBytes          int              `json:"windowBytes"`
	PieceCTChars         int              `json:"pieceCTChars"`
	ReadyMS              float64          `json:"transportReadyMs"`
	AuthMS               float64          `json:"relayAuthMs"`
	PayloadBytes         uint64           `json:"payloadBytes"`
	GoodputMbps          float64          `json:"goodputMbps"`
	CompletedChunks      uint64           `json:"completedChunks"`
	DrainComplete        bool             `json:"drainComplete"`
	Probes               []probe          `json:"probes"`
	Errors               []string         `json:"errors"`
	NodePID              int              `json:"nodePid"`
	Ports                []int            `json:"ports"`
	Cleanup              bool             `json:"cleanup"`
}
type progressSample struct {
	ElapsedMS              int64                 `json:"elapsedMs"`
	ReceivedChunks         uint64                `json:"receivedChunks"`
	UploadedChunks         uint64                `json:"uploadedChunks"`
	SentChunks             uint64                `json:"sentChunks"`
	VerifiedWindowBytes    uint64                `json:"verifiedWindowBytes"`
	ReceivedTransportBytes [3]uint64             `json:"receivedTransportBytes"`
	Stats                  *quic.ConnectionStats `json:"quicStats,omitempty"`
}
type endpoint struct {
	q  *relayquic.MultiClient
	ws *websocket.Conn
	mu sync.Mutex
}

func (e *endpoint) write(lane int, b []byte) error {
	if e.q != nil {
		return e.q.WriteLane(lane, b)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return e.ws.WriteMessage(websocket.TextMessage, b)
}
func (e *endpoint) close() {
	if e.q != nil {
		e.q.Close()
	} else if e.ws != nil {
		_ = e.ws.Close()
	}
}
func mustJSON(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}
func decode64(s string) []byte {
	b, e := base64.StdEncoding.DecodeString(s)
	if e != nil {
		panic(e)
	}
	return b
}
func aead(key []byte) cipher.AEAD {
	c, e := aes.NewCipher(key)
	if e != nil {
		panic(e)
	}
	a, e := cipher.NewGCM(c)
	if e != nil {
		panic(e)
	}
	return a
}
func nonce(lane int, n uint64) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint32(b, uint32(lane+1))
	binary.BigEndian.PutUint64(b[4:], n)
	return b
}
func aad(h header) []byte {
	return []byte(fmt.Sprintf("k=%s\nroom=%s\nfrom=%s\nto=%s\nch=%s\nn=%d", h.K, h.Room, h.From, h.To, h.Ch, h.N))
}

type cryptoEndpoint struct {
	e       *endpoint
	a       cipher.AEAD
	version int
	mu      [3]sync.Mutex
	seq     [3]uint64
}

func (c *cryptoEndpoint) send(lane int, kind string, plain []byte) error {
	c.mu[lane].Lock()
	defer c.mu[lane].Unlock()
	c.seq[lane]++
	h := header{K: kind, Room: "perf-host", From: "perf-device", To: "perf-host", N: c.seq[lane], Ch: lanes[lane]}
	ct := base64.RawURLEncoding.EncodeToString(c.a.Seal(nil, nonce(lane, h.N), plain, aad(h)))
	if len(ct) <= 8192 {
		return c.e.write(lane, mustJSON(frame{"v2.frame", c.version, envelope{2, h, ct}}))
	}
	for pos, idx := 0, 0; pos < len(ct); pos, idx = pos+8192, idx+1 {
		end := min(pos+8192, len(ct))
		ph := h
		ph.K = "piece"
		ph.IK = kind
		ph.Mid = fmt.Sprintf("d-%s-%d", h.Ch, h.N)
		ph.Idx = &idx
		last := end == len(ct)
		ph.Last = &last
		if err := c.e.write(lane, mustJSON(frame{"v2.frame", c.version, envelope{2, ph, ct[pos:end]}})); err != nil {
			return err
		}
	}
	return nil
}
func (c *cryptoEndpoint) control(v any) error { return c.send(0, "ping", mustJSON(v)) }

type reassembly struct {
	seq  uint64
	mid  string
	next int
	b    strings.Builder
	last uint64
}

func (r *reassembly) open(f frame, lane int, a cipher.AEAD) ([]byte, error) {
	h, ct := f.Envelope.Hdr, f.Envelope.CT
	if h.From != "perf-host" || h.To != "perf-device" || h.Room != "perf-host" || h.Ch != lanes[lane] {
		return nil, errors.New("routing mismatch")
	}
	if h.K == "piece" {
		if h.Idx == nil || h.Last == nil {
			return nil, errors.New("piece metadata missing")
		}
		if r.mid == "" {
			if *h.Idx != 0 {
				return nil, errors.New("first piece missing")
			}
			r.seq = h.N
			r.mid = h.Mid
			r.next = 0
		}
		if r.seq != h.N || r.mid != h.Mid || r.next != *h.Idx {
			return nil, errors.New("piece sequence mismatch")
		}
		r.b.WriteString(ct)
		r.next++
		if r.b.Len() > 32*1024*1024 {
			return nil, errors.New("piece budget exceeded")
		}
		if !*h.Last {
			return nil, nil
		}
		ct = r.b.String()
		r.b.Reset()
		r.mid = ""
		h.K = h.IK
	}
	if h.N != r.last+1 {
		return nil, fmt.Errorf("encrypted sequence %d after %d", h.N, r.last)
	}
	sealed, err := base64.RawURLEncoding.DecodeString(ct)
	if err != nil {
		return nil, err
	}
	plain, err := a.Open(nil, nonce(lane, h.N), sealed, aad(h))
	if err == nil {
		r.last = h.N
	}
	return plain, err
}

func certificates() (*tls.Config, *tls.Config, error) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return nil, nil, e
	}
	t := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(2 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, t, t, &key.PublicKey, key)
	if e != nil {
		return nil, nil, e
	}
	cert, e := x509.ParseCertificate(der)
	if e != nil {
		return nil, nil, e
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13}, &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS13}, nil
}

func run(ctx context.Context, node, scenario, protocol string, round int, warmup, duration, drain time.Duration) (out result) {
	ctx, cancelRun := context.WithTimeout(ctx, warmup+duration+drain+45*time.Second)
	defer cancelRun()
	out = result{Protocol: protocol, Scenario: scenario, Round: round, Started: time.Now().UTC().Format(time.RFC3339Nano), WarmupSeconds: warmup.Seconds(), Seconds: duration.Seconds(), DrainSeconds: drain.Seconds(), PieceCTChars: 8192, Errors: []string{}, Probes: []probe{}}
	out.Workload = os.Getenv("ORBIS_PERF_WORKLOAD")
	if out.Workload == "" {
		out.Workload = "original"
	}
	var failuresMu sync.Mutex
	failed := make(chan struct{}, 1)
	fail := func(e error) {
		if e != nil {
			failuresMu.Lock()
			out.Errors = append(out.Errors, e.Error())
			failuresMu.Unlock()
			select {
			case failed <- struct{}{}:
			default:
			}
		}
	}
	process := exec.Command(node, "testdata/perf-relay.mjs")
	hostMode := "ws"
	if protocol == "quic" {
		hostMode = "quic"
	}
	process.Env = append(os.Environ(), "ORBIS_PERF_HOST_TRANSPORT="+hostMode)
	if strings.HasPrefix(out.Workload, "history-") {
		if scenario != "download" {
			fail(errors.New("history diagnostic supports downstream history only"))
			return
		}
		process.Env = append(process.Env, "ORBIS_PERF_CHUNK_BYTES=262144")
	}
	process.Stderr = os.Stderr
	stdout, err := process.StdoutPipe()
	if err != nil {
		fail(err)
		return
	}
	if err = process.Start(); err != nil {
		fail(err)
		return
	}
	out.NodePID = process.Process.Pid
	defer func() {
		_ = process.Process.Signal(os.Interrupt)
		wait := make(chan error, 1)
		go func() { wait <- process.Wait() }()
		clean := true
		select {
		case e := <-wait:
			if e != nil {
				fail(fmt.Errorf("node exit: %w", e))
			}
		case <-time.After(5 * time.Second):
			_ = process.Process.Kill()
			<-wait
			clean = false
			fail(errors.New("node required forced cleanup"))
		}
		out.Cleanup = clean
	}()
	metaCh := make(chan metadata, 1)
	go func() {
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 4096), 8*1024*1024)
		var m metadata
		if scan.Scan() {
			_ = json.Unmarshal(scan.Bytes(), &m)
		}
		metaCh <- m
	}()
	var m metadata
	select {
	case m = <-metaCh:
	case <-time.After(15 * time.Second):
		fail(errors.New("Node metadata timeout"))
		return
	case <-ctx.Done():
		fail(ctx.Err())
		return
	}
	if m.Upstream == "" {
		fail(errors.New("missing fixture metadata"))
		return
	}
	out.HostProtocol = m.HostTransport
	if m.Remote {
		out.RemoteEndpoint = m.Upstream
		if m.HostTransport != hostMode {
			fail(errors.New("Host used unexpected transport"))
			return
		}
	}
	payload := decode64(m.Payload)
	out.ChunkBytes = len(payload)
	// Existing downloads start at 4 MiB; a single upload has one chunk in
	// flight. Keep that distinction instead of manufacturing upload pressure.
	if scenario == "upload" {
		m.WindowChunks = 1
		if value := os.Getenv("ORBIS_PERF_UPLOAD_WINDOW_CHUNKS"); value != "" {
			chunks, e := strconv.Atoi(value)
			if e != nil || chunks < 1 || chunks*len(payload) > 8*1024*1024 {
				fail(errors.New("invalid diagnostic upload window"))
				return
			}
			m.WindowChunks = chunks
		}
	}
	out.WindowBytes = m.WindowChunks * len(payload)
	upstream, _ := url.Parse(m.Upstream)
	p, _ := net.LookupPort("tcp", upstream.Port())
	out.Ports = append(out.Ports, p)
	serverTLS, clientTLS, err := certificates()
	if err != nil {
		fail(err)
		return
	}
	localCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var ep endpoint
	start := time.Now()
	if m.Remote {
		pem, e := os.ReadFile(m.CAFile)
		if e != nil {
			fail(e)
			return
		}
		roots := x509.NewCertPool()
		if !roots.AppendCertsFromPEM(pem) {
			fail(errors.New("invalid remote test CA"))
			return
		}
		clientTLS = &tls.Config{RootCAs: roots, ServerName: upstream.Hostname(), MinVersion: tls.VersionTLS13}
		setup, stopSetup := context.WithTimeout(ctx, 5*time.Second)
		if protocol == "quic" {
			ep.q, err = relayquic.DialMulti(setup, net.JoinHostPort(upstream.Hostname(), fmt.Sprint(m.QuicPort)), clientTLS)
		} else {
			dialer := websocket.Dialer{TLSClientConfig: clientTLS, HandshakeTimeout: 5 * time.Second, EnableCompression: false}
			ep.ws, _, err = dialer.DialContext(setup, m.Upstream, nil)
		}
		stopSetup()
	} else if protocol == "quic" {
		serverTLS.NextProtos = []string{relayquic.ALPNMulti}
		listener, e := quic.ListenAddr("127.0.0.1:0", serverTLS, relayquic.ConfigMulti())
		if e != nil {
			fail(e)
			return
		}
		out.Ports = append(out.Ports, listener.Addr().(*net.UDPAddr).Port)
		done := make(chan error, 1)
		go func() { done <- relayquic.Serve(localCtx, listener, m.Upstream, 16) }()
		defer func() {
			cancel()
			_ = listener.Close()
			select {
			case e := <-done:
				fail(e)
			case <-time.After(5 * time.Second):
				fail(errors.New("QUIC server cleanup timeout"))
			}
		}()
		dialCtx, stop := context.WithTimeout(localCtx, 3*time.Second)
		ep.q, err = relayquic.DialMulti(dialCtx, listener.Addr().String(), clientTLS)
		stop()
	} else {
		target := *upstream
		target.Scheme = "http"
		target.Path = ""
		proxy := httputil.NewSingleHostReverseProxy(&target)
		transport := &http.Transport{Proxy: nil}
		proxy.Transport = transport
		defer transport.CloseIdleConnections()
		listener, e := tls.Listen("tcp", "127.0.0.1:0", serverTLS)
		if e != nil {
			fail(e)
			return
		}
		out.Ports = append(out.Ports, listener.Addr().(*net.TCPAddr).Port)
		server := &http.Server{Handler: proxy, ReadHeaderTimeout: 3 * time.Second}
		done := make(chan error, 1)
		go func() { done <- server.Serve(listener) }()
		defer func() { _ = server.Close(); <-done }()
		dialer := websocket.Dialer{TLSClientConfig: clientTLS, HandshakeTimeout: 3 * time.Second, EnableCompression: false}
		ep.ws, _, err = dialer.DialContext(localCtx, "wss://"+listener.Addr().String()+"/v1/device", nil)
	}
	if err != nil {
		fail(err)
		return
	}
	defer ep.close()
	stopEndpoint := context.AfterFunc(ctx, ep.close)
	defer stopEndpoint()
	out.ReadyMS = float64(time.Since(start).Microseconds()) / 1000
	auth := mustJSON(map[string]any{"type": "device.authenticate", "protocolVersion": m.Version, "credential": m.Credential})
	start = time.Now()
	if err = ep.write(0, auth); err != nil {
		fail(err)
		return
	}
	// Authentication is outside the throughput/latency measurement interval.
	var ready []byte
	if ep.q != nil {
		ready, err = ep.q.ReadLane(0)
	} else {
		_, ready, err = ep.ws.ReadMessage()
	}
	if err != nil || !bytes.Contains(ready, []byte(`"device.ready"`)) {
		fail(fmt.Errorf("relay authentication failed: %v", err))
		return
	}
	out.AuthMS = float64(time.Since(start).Microseconds()) / 1000
	crypt := &cryptoEndpoint{e: &ep, a: aead(decode64(m.DeviceKey)), version: m.Version}
	decrypt := aead(decode64(m.HostKey))
	var received, uploaded, sent, measured atomic.Uint64
	var transportReceived, transportMeasured [3]atomic.Uint64
	var ending atomic.Bool
	var readers, workers sync.WaitGroup
	var probesMu sync.Mutex
	probes := map[int]*probe{}
	started := make(chan struct{}, 1)
	stopped := make(chan struct {
		Sent uint64 `json:"sent"`
	}, 1)
	wake := make(chan struct{}, 1)
	t0 := time.Now()
	measureStart := t0.Add(warmup)
	measureEnd := measureStart.Add(duration)
	progressDone := make(chan []progressSample, 1)
	progressStop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		samples := []progressSample{}
		for {
			select {
			case <-ticker.C:
				s := progressSample{ElapsedMS: time.Since(t0).Milliseconds(), ReceivedChunks: received.Load(), UploadedChunks: uploaded.Load(), SentChunks: sent.Load(), VerifiedWindowBytes: measured.Load()}
				for lane := range transportReceived {
					s.ReceivedTransportBytes[lane] = transportReceived[lane].Load()
				}
				if ep.q != nil {
					stats := ep.q.ConnectionStats()
					s.Stats = &stats
				}
				samples = append(samples, s)
			case <-progressStop:
				progressDone <- samples
				return
			}
		}
	}()
	defer func() {
		close(progressStop)
		out.Progress = <-progressDone
		for lane := range transportMeasured {
			out.WindowTransportBytes[lane] = transportMeasured[lane].Load()
		}
	}()
	var rs [3]reassembly
	count := func() {
		now := time.Now()
		if !now.Before(measureStart) && now.Before(measureEnd) {
			measured.Add(uint64(len(payload) - 8))
		}
	}
	handle := func(b []byte) error {
		var f frame
		if e := json.Unmarshal(b, &f); e != nil {
			return e
		}
		if f.Type != "v2.frame" {
			return fmt.Errorf("unexpected message: %s", f.Type)
		}
		lane := -1
		for i, n := range lanes {
			if f.Envelope.Hdr.Ch == n {
				lane = i
			}
		}
		if lane < 0 {
			return errors.New("missing lane")
		}
		transportReceived[lane].Add(uint64(len(b)))
		if now := time.Now(); !now.Before(measureStart) && now.Before(measureEnd) {
			transportMeasured[lane].Add(uint64(len(b)))
		}
		plain, e := rs[lane].open(f, lane, decrypt)
		if e != nil {
			return e
		}
		if plain == nil {
			return nil
		}
		historyPayload := false
		if strings.HasPrefix(out.Workload, "history-") && lane != 0 {
			var history struct {
				Op   string `json:"op"`
				N    uint64 `json:"n"`
				Text string `json:"text"`
			}
			if e = json.Unmarshal(plain, &history); e != nil {
				return e
			}
			if history.Op == "diagnostic.history" {
				wantLane := 1
				if out.Workload == "history-background" {
					wantLane = 2
				}
				if lane != wantLane {
					return errors.New("history diagnostic used the wrong stream")
				}
				plain = make([]byte, 8+len(history.Text))
				binary.BigEndian.PutUint64(plain, history.N)
				copy(plain[8:], history.Text)
				historyPayload = true
			}
		}
		if lane == 2 || historyPayload {
			if len(plain) != len(payload) || binary.BigEndian.Uint64(plain) != received.Load()+1 || !bytes.Equal(plain[8:], payload[8:]) {
				return errors.New("download content/sequence mismatch")
			}
			n := received.Add(1)
			count()
			return crypt.control(map[string]any{"op": "ack", "n": n})
		}
		var message struct {
			Op   string `json:"op"`
			ID   int    `json:"id"`
			N    uint64 `json:"n"`
			Sent uint64 `json:"sent"`
		}
		if e = json.Unmarshal(plain, &message); e != nil {
			return e
		}
		switch message.Op {
		case "ping":
			probesMu.Lock()
			p := probes[message.ID]
			if p == nil {
				probesMu.Unlock()
				return errors.New("unknown probe")
			}
			ms := float64(time.Since(t0).Nanoseconds())/1e6 - p.ScheduledMS
			if p.RTTMS != nil {
				probesMu.Unlock()
				return errors.New("duplicate probe")
			}
			p.RTTMS = &ms
			probesMu.Unlock()
		case "started":
			started <- struct{}{}
		case "stopped":
			stopped <- struct {
				Sent uint64 `json:"sent"`
			}{message.Sent}
		case "upload-ack":
			if message.N != uploaded.Load()+1 {
				return errors.New("upload ack sequence mismatch")
			}
			uploaded.Add(1)
			count()
			select {
			case wake <- struct{}{}:
			default:
			}
		default:
			return fmt.Errorf("unexpected operation: %s", message.Op)
		}
		return nil
	}
	if ep.q != nil {
		for lane := 0; lane < 3; lane++ {
			readers.Add(1)
			go func(lane int) {
				defer readers.Done()
				for {
					b, e := ep.q.ReadLane(lane)
					if e != nil {
						if !ending.Load() {
							fail(e)
						}
						return
					}
					if e = handle(b); e != nil {
						fail(e)
						return
					}
				}
			}(lane)
		}
	} else {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				_, b, e := ep.ws.ReadMessage()
				if e != nil {
					if !ending.Load() {
						fail(e)
					}
					return
				}
				if e = handle(b); e != nil {
					fail(e)
					return
				}
			}
		}()
	}
	// Snapshot after workers/readers join, including every early failure.
	defer func() {
		// Every scheduled measured request is retained, including missing replies.
		missing := 0
		probesMu.Lock()
		for id := 0; time.Duration(id)*100*time.Millisecond < warmup+duration; id++ {
			if time.Duration(id)*100*time.Millisecond < warmup {
				continue
			}
			p := probes[id]
			if p == nil {
				missing++
				out.Probes = append(out.Probes, probe{ID: id, ScheduledMS: float64(id * 100), Error: "not sent"})
				continue
			}
			if p.RTTMS == nil {
				missing++
				p.Error = "no reply within drain deadline"
			}
			out.Probes = append(out.Probes, *p)
		}
		probesMu.Unlock()
		if missing != 0 {
			fail(fmt.Errorf("%d measured control probes incomplete", missing))
		}
		out.PayloadBytes = measured.Load()
		out.GoodputMbps = float64(out.PayloadBytes) * 8 / duration.Seconds() / 1e6
		out.CompletedChunks = received.Load() + uploaded.Load()
	}()
	defer func() { ending.Store(true); cancel(); ep.close(); workers.Wait(); readers.Wait() }()
	if err = crypt.control(map[string]any{"op": "start", "direction": scenario}); err != nil {
		fail(err)
		return
	}
	select {
	case <-started:
		out.MeasurementStarted = true
	case <-failed:
		return
	case <-time.After(5 * time.Second):
		fail(errors.New("start timeout"))
		return
	case <-ctx.Done():
		fail(ctx.Err())
		return
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		for id := 0; ; id++ {
			scheduled := t0.Add(time.Duration(id) * 100 * time.Millisecond)
			if !scheduled.Before(measureEnd) {
				return
			}
			select {
			case <-time.After(max(0, time.Until(scheduled))):
			case <-localCtx.Done():
				return
			}
			p := &probe{ID: id, ScheduledMS: float64(scheduled.Sub(t0).Nanoseconds()) / 1e6, SendDelayMS: float64(time.Since(scheduled).Nanoseconds()) / 1e6}
			probesMu.Lock()
			probes[id] = p
			probesMu.Unlock()
			if e := crypt.control(map[string]any{"op": "ping", "id": id}); e != nil {
				fail(e)
				return
			}
		}
	}()
	if scenario == "upload" {
		workers.Add(1)
		go func() {
			defer workers.Done()
			chunk := bytes.Clone(payload)
			for time.Now().Before(measureEnd) {
				if sent.Load()-uploaded.Load() >= uint64(m.WindowChunks) {
					select {
					case <-wake:
					case <-localCtx.Done():
						return
					}
					continue
				}
				n := sent.Add(1)
				binary.BigEndian.PutUint64(chunk, n)
				if e := crypt.send(2, "bin", chunk); e != nil {
					if !ending.Load() {
						fail(e)
					}
					return
				}
			}
		}()
	}
	select {
	case <-time.After(max(0, time.Until(measureEnd))):
		out.MeasurementComplete = true
	case <-failed:
		return
	case <-ctx.Done():
		fail(ctx.Err())
		return
	}
	// One shared post-measurement budget; it never extends the goodput window.
	drainEnd := time.Now().Add(drain)
	workersDone := make(chan struct{})
	go func() { workers.Wait(); close(workersDone) }()
	select {
	case <-workersDone:
	case <-failed:
		return
	case <-ctx.Done():
		fail(ctx.Err())
		return
	case <-time.After(max(0, time.Until(drainEnd))):
		fail(errors.New("sender drain timeout"))
		return
	}
	out.PayloadBytes = measured.Load()
	out.GoodputMbps = float64(out.PayloadBytes) * 8 / duration.Seconds() / 1e6
	if err = crypt.control(map[string]any{"op": "stop"}); err != nil {
		fail(err)
		return
	}
	var target uint64
	select {
	case x := <-stopped:
		target = x.Sent
	case <-failed:
		return
	case <-time.After(max(0, time.Until(drainEnd))):
		fail(errors.New("stop timeout"))
		return
	}
	for time.Now().Before(drainEnd) {
		if (scenario != "download" || received.Load() == target) && (scenario != "upload" || uploaded.Load() == sent.Load()) {
			out.DrainComplete = true
			probesMu.Lock()
			allReplied := true
			for _, p := range probes {
				if p.RTTMS == nil {
					allReplied = false
					break
				}
			}
			probesMu.Unlock()
			if allReplied {
				break
			}
		}
		select {
		case <-time.After(10 * time.Millisecond):
		case <-failed:
			return
		}
	}
	if !out.DrainComplete {
		fail(errors.New("bulk drain timeout"))
	}

	return
}

func main() {
	node := flag.String("node", "node", "Node executable")
	rounds := flag.Int("rounds", 5, "interleaved pairs per scenario")
	warmup := flag.Duration("warmup", 10*time.Second, "bulk warmup")
	duration := flag.Duration("duration", 60*time.Second, "bulk measurement")
	drain := flag.Duration("drain", 60*time.Second, "shared post-measurement sender, receiver and probe drain budget")
	idleDuration := flag.Duration("idle-duration", 10*time.Second, "idle measurement; warmup is 2s")
	scenarios := flag.String("scenarios", "idle,download,upload", "comma-separated workloads")
	workloads := flag.String("workloads", "", "optional interleaved original,pipelined diagnostic loads")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	enc := json.NewEncoder(os.Stdout)
	failed := false
	for _, scenario := range strings.Split(*scenarios, ",") {
		if scenario != "idle" && scenario != "download" && scenario != "upload" {
			panic("unsupported scenario")
		}
		w, d := *warmup, *duration
		if scenario == "idle" {
			w = 2 * time.Second
			d = *idleDuration
		}
		for round := 1; round <= *rounds; round++ {
			loadOrder := []string{""}
			if *workloads != "" {
				loadOrder = strings.Split(*workloads, ",")
				if round%2 == 0 {
					for i, j := 0, len(loadOrder)-1; i < j; i, j = i+1, j-1 {
						loadOrder[i], loadOrder[j] = loadOrder[j], loadOrder[i]
					}
				}
			}
			for _, workload := range loadOrder {
				if workload != "" {
					if workload != "original" && workload != "pipelined" && workload != "history-shared" && workload != "history-background" {
						panic("unsupported diagnostic workload")
					}
					_ = os.Setenv("ORBIS_PERF_WORKLOAD", workload)
					_ = os.Unsetenv("ORBIS_PERF_CHUNK_BYTES")
					_ = os.Unsetenv("ORBIS_PERF_UPLOAD_WINDOW_CHUNKS")
					if workload == "pipelined" {
						_ = os.Setenv("ORBIS_PERF_CHUNK_BYTES", "65536")
						_ = os.Setenv("ORBIS_PERF_UPLOAD_WINDOW_CHUNKS", "64")
					}
				}
				order := []string{"wss", "quic"}
				if round%2 == 0 {
					order = []string{"quic", "wss"}
				}
				for _, protocol := range order {
					fmt.Fprintf(os.Stderr, "START scenario=%s round=%d protocol=%s workload=%s at=%s\n", scenario, round, protocol, os.Getenv("ORBIS_PERF_WORKLOAD"), time.Now().UTC().Format(time.RFC3339))
					r := run(ctx, *node, scenario, protocol, round, w, d, *drain)
					_ = enc.Encode(r)
					fmt.Fprintf(os.Stderr, "DONE scenario=%s round=%d protocol=%s workload=%s Mbps=%.3f errors=%d cleanup=%v\n", scenario, round, protocol, r.Workload, r.GoodputMbps, len(r.Errors), r.Cleanup)
					if len(r.Errors) > 0 || !r.Cleanup {
						failed = true
					}
					if ctx.Err() != nil {
						os.Exit(2)
					}
				}
			}
		}
	}
	if failed {
		os.Exit(1)
	}
}
