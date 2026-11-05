package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/WGooold/Orbis/native/relayquic/hostipc"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if hostipc.Run(ctx, os.Stdin, os.Stdout) != nil {
		// Never include frames, auth tokens or configuration in helper diagnostics.
		fmt.Fprintln(os.Stderr, "native QUIC helper closed")
		os.Exit(1)
	}
}
