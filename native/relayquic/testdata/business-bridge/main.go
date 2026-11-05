// Test-only network adapter for the existing HostService functional suite.
// The reference phone keeps its original WS API and business assertions, while
// every device frame traverses a real QUIC client, server and Node Relay.
// This extra local WS hop is not a mobile/performance/flow-control benchmark.
package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/WGooold/Orbis/native/relayquic"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
)

func run() error {
	if len(os.Args) != 2 {
		return errors.New("requires one isolated loopback Relay device URL")
	}
	if err := relayquic.ValidateUpstream(os.Args[1]); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	trustDir, err := os.MkdirTemp("", "orbis-quic-fixture-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(trustDir)
	caFile := filepath.Join(trustDir, "ca.pem")
	if err = os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600); err != nil {
		return err
	}
	serverTLS := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, NextProtos: []string{relayquic.ALPNFive, relayquic.ALPNHostFive, relayquic.ALPNMulti, relayquic.ALPNHostMulti}}
	clientTLS := &tls.Config{RootCAs: roots, ServerName: "localhost"}
	listener, err := quic.ListenAddr("127.0.0.1:0", serverTLS, relayquic.ConfigFive())
	if err != nil {
		return err
	}
	defer listener.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// The test runner owns stdin. If it exits without hooks, release the fixture
	// instead of leaving a listener behind until a later task discovers it.
	commands := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			select {
			case commands <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		cancel()
	}()
	// A separate test-only Host listener lets the regression drop that leg
	// without disconnecting the reference phone or restarting the Node Relay.
	var hostListener *quic.Listener
	var hostPacket net.PacketConn
	var stopHost context.CancelFunc
	var hostDone chan error
	startHost := func(address string) error {
		var e error
		hostPacket, e = net.ListenPacket("udp", address)
		if e != nil {
			return e
		}
		hostListener, e = quic.Listen(hostPacket, serverTLS, relayquic.ConfigFive())
		if e != nil {
			_ = hostPacket.Close()
			return e
		}
		hostCtx, stop := context.WithCancel(ctx)
		stopHost = stop
		hostDone = make(chan error, 1)
		go func() {
			hostDone <- relayquic.ServeRoutes(hostCtx, hostListener, os.Args[1], strings.TrimSuffix(os.Args[1], "/v1/device")+"/v1/runtime", 16)
		}()
		return nil
	}
	if err = startHost("127.0.0.1:0"); err != nil {
		return err
	}
	defer func() {
		stopHost()
		<-hostDone
		if hostPacket != nil {
			_ = hostPacket.Close()
		}
	}()
	served := make(chan error, 1)
	go func() {
		served <- relayquic.ServeRoutes(ctx, listener, os.Args[1], strings.TrimSuffix(os.Args[1], "/v1/device")+"/v1/runtime", 16)
	}()
	var handlers sync.WaitGroup
	upgrader := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/device", func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		setup, stopSetup := context.WithTimeout(ctx, 3*time.Second)
		dial := relayquic.DialMulti
		if os.Getenv("ORBIS_TEST_HISTORY_STREAMS") == "1" {
			dial = relayquic.DialFive
		}
		client, dialErr := dial(setup, listener.Addr().String(), clientTLS)
		stopSetup()
		if dialErr != nil {
			http.Error(w, "QUIC setup failed", http.StatusBadGateway)
			return
		}
		defer client.Close()
		ws, upgradeErr := upgrader.Upgrade(w, r, nil)
		if upgradeErr != nil {
			return
		}
		defer ws.Close()
		ws.SetReadLimit(relayquic.MaxFrameSize)
		stop := context.AfterFunc(ctx, func() { client.Close(); _ = ws.Close() })
		defer stop()
		done := make(chan struct{}, 2)
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				kind, frame, err := ws.ReadMessage()
				if err != nil || kind != websocket.TextMessage || client.Write(frame) != nil {
					return
				}
			}
		}()
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				frame, err := client.Read()
				if err != nil || ws.WriteMessage(websocket.TextMessage, frame) != nil {
					return
				}
			}
		}()
		<-done
		client.Close()
		_ = ws.Close()
		<-done
	})
	local, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancel()
		<-served
		return err
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second}
	httpDone := make(chan error, 1)
	go func() { httpDone <- server.Serve(local) }()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"url": "ws://" + local.Addr().String() + "/v1/device", "transport": "quic", "alpn": func() string {
			if os.Getenv("ORBIS_TEST_HISTORY_STREAMS") == "1" {
				return relayquic.ALPNFive
			}
			return relayquic.ALPNMulti
		}(),
		"quicPort": hostListener.Addr().(*net.UDPAddr).Port, "caFile": caFile,
	}); err != nil {
		cancel()
	}
commandLoop:
	for {
		select {
		case <-ctx.Done():
			break commandLoop
		case command := <-commands:
			if command != "restart-host" {
				cancel()
				break commandLoop
			}
			address := hostListener.Addr().String()
			stopHost()
			hostErr := <-hostDone
			_ = hostPacket.Close()
			// Leave a consumed completion available for deferred cleanup if rebinding fails.
			hostDone <- nil
			if hostErr != nil {
				err = hostErr
				cancel()
				break commandLoop
			}
			if err = startHost(address); err != nil {
				cancel()
				break commandLoop
			}
			if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "host.restarted"}); err != nil {
				cancel()
				break commandLoop
			}
		}
	}
	shutdown, stopShutdown := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopShutdown()
	shutdownErr := server.Shutdown(shutdown)
	if shutdownErr != nil {
		_ = server.Close()
	}
	handlers.Wait()
	quicErr := <-served
	httpErr := <-httpDone
	if httpErr != nil && !errors.Is(httpErr, http.ErrServerClosed) {
		return httpErr
	}
	if quicErr != nil {
		return quicErr
	}
	if err != nil {
		return err
	}
	return shutdownErr
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
