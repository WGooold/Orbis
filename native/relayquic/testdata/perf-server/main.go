// Isolated Relay side of the real-link benchmark. Owned by one foreground SSH
// session: stdin EOF or a bounded deadline closes both protocols and joins Node.
package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/WGooold/Orbis/native/relayquic"
	"github.com/WGooold/Orbis/native/relayquic/diagnostics"
	quic "github.com/quic-go/quic-go"
)

func run() error {
	node := flag.String("node", "node", "Node executable")
	script := flag.String("script", "testdata/perf-server.mjs", "isolated Node Relay fixture")
	flag.Parse()
	var config struct {
		RuntimeCredential string   `json:"runtimeCredential"`
		Credential        string   `json:"credential"`
		Port              int      `json:"port"`
		IPs               []string `json:"ips"`
	}
	input := bufio.NewReader(os.Stdin)
	line, err := input.ReadString('\n')
	if err != nil || len(line) > 8192 || json.Unmarshal([]byte(line), &config) != nil || len(config.Credential) < 32 || len(config.RuntimeCredential) < 32 || config.Port < 1024 || config.Port > 65535 {
		return fmt.Errorf("invalid fixture configuration")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 50*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, input); cancel() }()
	process := exec.Command(*node, *script)
	process.Stderr = os.Stderr
	stdin, err := process.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := process.StdoutPipe()
	if err != nil {
		return err
	}
	if err = process.Start(); err != nil {
		return err
	}
	wait := make(chan error, 1)
	go func() { wait <- process.Wait(); cancel() }()
	defer func() {
		_ = stdin.Close()
		select {
		case <-wait:
		case <-time.After(5 * time.Second):
			_ = process.Process.Kill()
			<-wait
		}
	}()
	if _, err = io.WriteString(stdin, line); err != nil {
		return err
	}
	var metadata struct {
		Upstream    string `json:"upstream"`
		NodeVersion string `json:"nodeVersion"`
	}
	decoded := make(chan error, 1)
	go func() { decoded <- json.NewDecoder(stdout).Decode(&metadata) }()
	select {
	case err = <-decoded:
		if err != nil {
			return err
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), DNSNames: []string{"localhost"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, ip := range config.IPs {
		if parsed := net.ParseIP(ip); parsed != nil {
			cert.IPAddresses = append(cert.IPAddresses, parsed)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return err
	}
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS13,
		NextProtos: []string{relayquic.ALPNMulti, relayquic.ALPNHostMulti}}
	address := fmt.Sprintf("0.0.0.0:%d", config.Port)
	quicConfig := relayquic.ConfigMulti()
	if err := diagnostics.Configure(quicConfig, os.Getenv("ORBIS_QUIC_DIAGNOSTICS_FILE")); err != nil {
		return err
	}
	listener, err := quic.ListenAddr(address, tlsConfig, quicConfig)
	if err != nil {
		return err
	}
	defer listener.Close()
	quicDone := make(chan error, 1)
	go func() {
		quicDone <- relayquic.ServeRoutes(ctx, listener, metadata.Upstream+"/v1/device", metadata.Upstream+"/v1/runtime", 16)
	}()
	defer func() { cancel(); <-quicDone }()
	webTLS := tlsConfig.Clone()
	webTLS.NextProtos = nil
	tcp, err := tls.Listen("tcp", address, webTLS)
	if err != nil {
		return err
	}
	target, err := url.Parse(metadata.Upstream)
	if err != nil {
		return err
	}
	target.Scheme = "http"
	proxy := httputil.NewSingleHostReverseProxy(target)
	transport := &http.Transport{Proxy: nil}
	proxy.Transport = transport
	defer transport.CloseIdleConnections()
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 3 * time.Second}
	httpDone := make(chan error, 1)
	go func() { httpDone <- server.Serve(tcp) }()
	defer func() { _ = server.Close(); <-httpDone }()
	root := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err = json.NewEncoder(os.Stdout).Encode(map[string]any{"port": config.Port, "certificate": base64.StdEncoding.EncodeToString(root), "nodeVersion": metadata.NodeVersion}); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
