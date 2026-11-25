"""Relay an actual Unix PTY; stdin EOF tears down only this fixture's CLI."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def stop(_signum, _frame):
    raise SystemExit(0)


def main(argv):
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    pid, master = pty.fork()
    if pid == 0:
        # Set the size before OpenTUI first queries its terminal.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))
        os.execv(argv[0], argv)

    try:
        print(f"PTY child: {pid}", file=sys.stderr, flush=True)
        while True:
            ready, _, _ = select.select([0, master], [], [])
            if 0 in ready:
                keys = os.read(0, 4096)
                if not keys:
                    return 0
                os.write(master, keys)
            if master in ready:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
        # Leaving the TUI on its own is unexpected; preserve its real status.
        return os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    finally:
        os.close(master)
        try:
            pending = not os.waitpid(pid, os.WNOHANG)[0]
        except ChildProcessError:
            pending = False
        if pending:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.02)
            else:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
