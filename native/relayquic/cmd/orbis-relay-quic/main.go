package main

import (
	"context"
	"crypto/tls"
	"flag"
	"github.com/WGooold/Orbis/native/relayquic"
	quic "github.com/quic-go/quic-go"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	listen := flag.String("listen", ":443", "UDP listen address")
	cert := flag.String("cert", "", "TLS certificate chain PEM")
	key := flag.String("key", "", "TLS private key PEM")
	upstream := flag.String("upstream", "ws://127.0.0.1:8787/v1/device", "fixed loopback Relay endpoint")
	runtimeUpstream := flag.String("runtime-upstream", "ws://127.0.0.1:8787/v1/runtime", "fixed loopback Host endpoint; empty disables Host QUIC")
	limit := flag.Int("max-connections", 16, "maximum concurrent connections")
	flag.Parse()
	if err := relayquic.ValidateUpstream(*upstream); err != nil {
		log.Fatal(err)
	}
	if *runtimeUpstream != "" {
		if err := relayquic.ValidateRuntimeUpstream(*runtimeUpstream); err != nil {
			log.Fatal(err)
		}
	}
	if *limit < 1 {
		log.Fatal("max-connections must be positive")
	}
	pair, err := tls.LoadX509KeyPair(*cert, *key)
	if err != nil {
		log.Fatal("cannot load TLS certificate")
	}
	alpns := []string{relayquic.ALPNFive, relayquic.ALPNMulti}
	if *runtimeUpstream != "" {
		alpns = append(alpns, relayquic.ALPNHostFive, relayquic.ALPNHostMulti)
	}
	listener, err := quic.ListenAddr(*listen, &tls.Config{Certificates: []tls.Certificate{pair}, NextProtos: alpns, MinVersion: tls.VersionTLS13}, relayquic.ConfigFive())
	if err != nil {
		log.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	log.Printf("native QUIC listening on %s", listener.Addr())
	if err := relayquic.ServeRoutes(ctx, listener, *upstream, *runtimeUpstream, *limit); err != nil {
		log.Fatal(err)
	}
}
