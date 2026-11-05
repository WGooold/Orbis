// Test-only ingress for matching the existing HK -> Relay topology without
// reloading nginx. Both TCP/TLS and UDP/QUIC use the same fixed destination.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func run() error {
	listen := flag.String("listen", "127.0.0.1:24443", "isolated test listener")
	target := flag.String("target", "", "fixed benchmark Relay address")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 50*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	tcp, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer tcp.Close()
	uaddr, err := net.ResolveUDPAddr("udp", *listen)
	if err != nil {
		return err
	}
	udp, err := net.ListenUDP("udp", uaddr)
	if err != nil {
		return err
	}
	defer udp.Close()
	remote, err := net.ResolveUDPAddr("udp", *target)
	if err != nil {
		return err
	}
	stopListeners := context.AfterFunc(ctx, func() { _ = tcp.Close(); _ = udp.Close() })
	defer stopListeners()
	var workers sync.WaitGroup
	var routes sync.Map
	slots := make(chan struct{}, 32)
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			client, err := tcp.Accept()
			if err != nil {
				return
			}
			select {
			case slots <- struct{}{}:
			default:
				_ = client.Close()
				continue
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() { <-slots }()
				defer client.Close()
				peer, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", *target)
				if err != nil {
					return
				}
				defer peer.Close()
				closeBoth := func() { _ = client.Close(); _ = peer.Close() }
				stop := context.AfterFunc(ctx, closeBoth)
				defer stop()
				done := make(chan struct{})
				go func() { _, _ = io.Copy(peer, client); closeBoth(); close(done) }()
				_, _ = io.Copy(client, peer)
				closeBoth()
				<-done
			}()
		}
	}()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"type": "ingress.ready", "listen": *listen, "target": *target}); err != nil {
		cancel()
	}
	buf := make([]byte, 65535)
	for {
		n, address, err := udp.ReadFromUDP(buf)
		if err != nil {
			break
		}
		key := address.String()
		value, found := routes.Load(key)
		if !found {
			select {
			case slots <- struct{}{}:
			default:
				continue
			}
			peer, err := net.DialUDP("udp", nil, remote)
			if err != nil {
				<-slots
				continue
			}
			routes.Store(key, peer)
			value = peer
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer peer.Close()
				defer routes.Delete(key)
				defer func() { <-slots }()
				stop := context.AfterFunc(ctx, func() { _ = peer.Close() })
				defer stop()
				data := make([]byte, 65535)
				for {
					_ = peer.SetReadDeadline(time.Now().Add(45 * time.Second))
					n, err := peer.Read(data)
					if err != nil {
						return
					}
					if _, err = udp.WriteToUDP(data[:n], address); err != nil {
						return
					}
				}
			}()
		}
		peer := value.(*net.UDPConn)
		if _, err := peer.Write(buf[:n]); err != nil {
			_ = peer.Close()
		}
	}
	cancel()
	workers.Wait()
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
