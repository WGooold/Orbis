// Isolated native interoperability fixture. Certificates and data are ephemeral.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"github.com/WGooold/Orbis/native/relayquic"
	"github.com/gorilla/websocket"
	quic "github.com/quic-go/quic-go"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 || len(os.Args) > 3 {
		panic("fixture requires its isolated output directory")
	}
	dir := os.Args[1]
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"localhost"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		panic(err)
	}
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if ws.WriteMessage(kind, data) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	listener, err := quic.ListenAddr("127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, NextProtos: []string{relayquic.ALPNFive, relayquic.ALPNMulti, relayquic.ALPN}}, relayquic.ConfigFive())
	if err != nil {
		panic(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := os.WriteFile(filepath.Join(dir, "cert.der"), der, 0600); err != nil {
		panic(err)
	}
	info, _ := json.Marshal(map[string]any{"port": listener.Addr().(*net.UDPAddr).Port})
	if err := os.WriteFile(filepath.Join(dir, "ready.json"), info, 0600); err != nil {
		panic(err)
	}
	target := "ws" + upstream.URL[4:] + "/v1/device"
	if len(os.Args) == 3 {
		target = os.Args[2]
	}
	if err := relayquic.Serve(ctx, listener, target, 4); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
