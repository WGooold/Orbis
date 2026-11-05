// Package hostipc connects the Node Host to three native QUIC streams. Each lane
// has its own authenticated loopback connection and independent blocking pumps.
package hostipc

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/WGooold/Orbis/native/relayquic"
)

const Data byte = 0
const Written byte = 1

type Config struct {
	Address       string `json:"address"`
	ServerName    string `json:"serverName"`
	Token         string `json:"token"`
	CAFile        string `json:"caFile,omitempty"`
	StreamVersion int    `json:"streamVersion,omitempty"`
}

type laneClient interface {
	ReadLane(int) ([]byte, error)
	WriteLane(int, []byte) error
	Close()
}

func ReadPacket(r io.Reader) (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(header[:4])
	if n < 1 || n > relayquic.MaxFrameSize+1 || header[4] > Written {
		return 0, nil, relayquic.ErrFrame
	}
	b := make([]byte, int(n)-1)
	_, err := io.ReadFull(r, b)
	return header[4], b, err
}

func WritePacket(w io.Writer, op byte, b []byte) error {
	if len(b) > relayquic.MaxFrameSize || op > Written {
		return relayquic.ErrFrame
	}
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(b)+1))
	header[4] = op
	for _, part := range [][]byte{header[:], b} {
		for len(part) > 0 {
			n, err := w.Write(part)
			if err != nil {
				return err
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}

// Run never receives business credentials in its configuration. The parent owns
// stdin for the entire lifetime; EOF cancels even a blocked dial or lane writer.
func Run(ctx context.Context, stdin io.ReadCloser, stdout io.Writer) error {
	return run(ctx, stdin, stdout, func(ctx context.Context, config Config) (laneClient, error) {
		tlsConfig := &tls.Config{ServerName: config.ServerName, MinVersion: tls.VersionTLS13}
		if config.CAFile != "" {
			pem, err := os.ReadFile(config.CAFile)
			if err != nil {
				return nil, err
			}
			roots, err := x509.SystemCertPool()
			if err != nil {
				roots = x509.NewCertPool()
			}
			if !roots.AppendCertsFromPEM(pem) {
				return nil, errors.New("invalid additional CA")
			}
			tlsConfig.RootCAs = roots
		}
		if config.StreamVersion == 3 {
			return relayquic.DialHostFive(ctx, config.Address, tlsConfig)
		}
		return relayquic.DialHostMulti(ctx, config.Address, tlsConfig)
	})
}

func run(ctx context.Context, stdin io.ReadCloser, stdout io.Writer, dial func(context.Context, Config) (laneClient, error)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Closing stdin also joins the parent watcher on ordinary shutdown.
	stopInput := context.AfterFunc(ctx, func() { _ = stdin.Close() })
	defer stopInput()
	b, err := relayquic.ReadFrame(stdin)
	if err != nil {
		return err
	}
	var config Config
	if len(b) > 65536 || json.Unmarshal(b, &config) != nil || len(config.Token) != 64 || config.Address == "" || config.ServerName == "" {
		return errors.New("invalid helper configuration")
	}
	if config.StreamVersion != 0 && config.StreamVersion != 2 && config.StreamVersion != 3 {
		return errors.New("invalid stream version")
	}
	countLanes := 3
	if config.StreamVersion == 3 {
		countLanes = 5
	}
	watcher := make(chan struct{})
	go func() { defer close(watcher); var extra [1]byte; _, _ = stdin.Read(extra[:]); cancel() }()
	defer func() { cancel(); _ = stdin.Close(); <-watcher }()
	setup, endSetup := context.WithTimeout(ctx, 5*time.Second)
	defer endSetup()
	client, err := dial(setup, config)
	if err != nil {
		return err
	}
	defer client.Close()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return err
	}
	defer listener.Close()
	stop := context.AfterFunc(setup, func() { _ = listener.Close() })
	defer stop()
	if err = json.NewEncoder(stdout).Encode(map[string]any{"type": "ipc.listening", "port": listener.Addr().(*net.TCPAddr).Port}); err != nil {
		return err
	}
	lanes := make([]net.Conn, countLanes)
	defer func() {
		for _, c := range lanes {
			if c != nil {
				_ = c.Close()
			}
		}
	}()
	for count := 0; count < len(lanes); {
		conn, err := listener.AcceptTCP()
		if err != nil {
			return err
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		op, b, err := ReadPacket(conn)
		var auth struct {
			Token string `json:"token"`
			Lane  int    `json:"lane"`
		}
		if err != nil || op != Data || len(b) > 512 || json.Unmarshal(b, &auth) != nil || subtle.ConstantTimeCompare([]byte(auth.Token), []byte(config.Token)) != 1 || auth.Lane < 0 || auth.Lane >= len(lanes) || lanes[auth.Lane] != nil {
			_ = conn.Close()
			continue
		}
		_ = conn.SetDeadline(time.Time{})
		lanes[auth.Lane] = conn
		count++
	}
	_ = listener.Close()
	if setup.Err() != nil {
		return setup.Err()
	}
	if err := json.NewEncoder(stdout).Encode(map[string]string{"type": "transport.ready"}); err != nil {
		return err
	}
	var workers sync.WaitGroup
	done := make(chan error, 2*len(lanes))
	for lane, conn := range lanes {
		var writeMu sync.Mutex
		write := func(op byte, b []byte) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
			return WritePacket(conn, op, b)
		}
		workers.Add(2)
		go func() {
			defer workers.Done()
			for {
				op, b, err := ReadPacket(conn)
				if err == nil && op != Data {
					err = relayquic.ErrFrame
				}
				if err == nil {
					err = client.WriteLane(lane, b)
				}
				if err != nil {
					done <- err
					return
				}
				var ack [4]byte
				binary.BigEndian.PutUint32(ack[:], uint32(len(b)))
				if err = write(Written, ack[:]); err != nil {
					done <- err
					return
				}
			}
		}()
		go func() {
			defer workers.Done()
			for {
				b, err := client.ReadLane(lane)
				if err == nil {
					err = write(Data, b)
				}
				if err != nil {
					done <- err
					return
				}
			}
		}()
	}
	select {
	case err = <-done:
	case <-ctx.Done():
		err = ctx.Err()
	}
	client.Close()
	for _, conn := range lanes {
		_ = conn.Close()
	}
	workers.Wait()
	return err
}
