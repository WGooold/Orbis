#!/usr/bin/env python3
"""Own an isolated foreground public-link fixture and its narrow firewall rules.
No production configuration, containers, credentials or persistent data are used.
"""
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading

root = Path(__file__).resolve().parent
config = json.loads(sys.stdin.readline())
owner = config['owner']
if not re.fullmatch(r'orbis-quic-perf-[a-z0-9-]+', owner):
    raise ValueError('invalid owner')
port = config['port']
if not isinstance(port, int) or not 20000 <= port <= 60000:
    raise ValueError('invalid isolated port')
sources = [str(ipaddress.ip_address(value)) for value in config['sources']]
rules = []
child = None
cleanup_errors = []
before = subprocess.check_output(['ss', '-lntuH'], text=True)
if any(line.split()[4].endswith(':' + str(port)) for line in before.splitlines()):
    raise RuntimeError('test port is occupied')

def shutdown(signum, frame):
    if child is not None and child.poll() is None:
        child.terminate()

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)
try:
    status = subprocess.run(['ufw', 'status'], capture_output=True, text=True) if Path('/usr/sbin/ufw').exists() else None
    if status is not None and status.returncode == 0 and 'Status: active' in status.stdout:
        if str(port) in status.stdout:
            raise RuntimeError('test port already has firewall policy')
        for source in sources:
            for protocol in ['tcp', 'udp']:
                rule = ['allow', 'proto', protocol, 'from', source, 'to', 'any', 'port', str(port), 'comment', owner]
                subprocess.run(['ufw', *rule], check=True, stdout=sys.stderr, stderr=sys.stderr)
                rules.append(rule)
    if config['role'] == 'server':
        # Existing immutable Node image supplies only the runtime and dependencies;
        # the candidate JS modules are mounted read-only into this new container.
        command = ['docker', 'run', '--rm', '-i', '--name', owner, '--network', 'host',
                   '--read-only', '--memory=512m', '--cpus=1', '--pids-limit=64',
                   '--cap-drop=ALL', '--security-opt=no-new-privileges',
                   '-v', f'{root}:/work:ro',
                   '-v', f'{root}/relay-dist:/app/packages/relay/dist:ro',
                   '-v', f'{root}/protocol-dist:/app/packages/protocol/dist:ro',
                   '-e', 'ORBIS_PERF_RELAY_MODULE=file:///app/packages/relay/dist/index.js',
                   '-w', '/work', '--entrypoint', '/work/perf-server-linux', config['image'],
                   '-node', '/usr/local/bin/node', '-script', '/work/perf-server.mjs']
        if config.get('diagnostics'):
            evidence = root/'evidence'
            evidence.mkdir(mode=0o700, exist_ok=False)
            command[command.index('-w'):command.index('-w')] = ['-v', f'{evidence}:/evidence:rw',
                '--user', f'{os.getuid()}:{os.getgid()}',
                '-e', 'ORBIS_QUIC_DIAGNOSTICS_FILE=/evidence/server-metrics.jsonl']
    elif config['role'] == 'diagnostic':
        evidence = root/'evidence'
        evidence.mkdir(mode=0o700, exist_ok=False)
        command = ['docker', 'run', '--rm', '-i', '--name', owner, '--network', 'host',
                   '--read-only', '--memory=512m', '--cpus=1', '--pids-limit=64',
                   '--cap-drop=ALL', '--security-opt=no-new-privileges',
                   '--user', f'{os.getuid()}:{os.getgid()}',
                   '-v', f'{root}:/work:ro', '-v', f'{evidence}:/evidence:rw',
                   '-w', '/work', '--entrypoint', '/work/diagnostic-linux', config['image'],
                   '-role', 'server', '-metrics', '/evidence/server-metrics.jsonl']
    elif config['role'] == 'ingress':
        target = str(ipaddress.ip_address(config['target']))
        command = [str(root/'perf-ingress-linux'), '-listen', f'0.0.0.0:{port}', '-target', f'{target}:{port}']
    else:
        raise ValueError('invalid role')
    child = subprocess.Popen(command, stdin=subprocess.PIPE)
    if config['role'] in ['server', 'diagnostic']:
        keys = ['port', 'ips', 'token'] if config['role'] == 'diagnostic' else ['port', 'ips', 'runtimeCredential', 'credential']
        child.stdin.write((json.dumps({key: config[key] for key in keys})+'\n').encode())
        child.stdin.flush()

    def parent_watch():
        try:
            while os.read(sys.stdin.fileno(), 4096):
                pass
        finally:
            try:
                child.stdin.close()
            except (OSError, ValueError):
                pass
    threading.Thread(target=parent_watch, daemon=True).start()
    code = child.wait()
finally:
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(); cleanup_errors.append('fixture required SIGKILL')
    if config['role'] in ['server', 'diagnostic']:
        remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter', f'name=^/{owner}$'], text=True).strip()
        if remaining:
            result = subprocess.run(['docker', 'rm', '-f', owner], capture_output=True, text=True)
            if result.returncode:
                cleanup_errors.append('owned container removal failed')
    for rule in reversed(rules):
        result = subprocess.run(['ufw', '--force', 'delete', *rule], capture_output=True, text=True)
        if result.returncode:
            cleanup_errors.append('owned firewall rule removal failed')
    after = subprocess.check_output(['ss', '-lntuH'], text=True)
    if any(line.split()[4].endswith(':' + str(port)) for line in after.splitlines()):
        cleanup_errors.append('test port still listening')
    print(json.dumps({'type':'cleanup','owner':owner,'errors':cleanup_errors,'released':not cleanup_errors}), flush=True)
if cleanup_errors:
    sys.exit(2)
sys.exit(code)
