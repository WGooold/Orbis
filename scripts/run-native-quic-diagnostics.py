#!/usr/bin/env python3
"""Own a source-restricted raw TLS/QUIC diagnostic; always join and verify cleanup."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import shlex
import shutil
import signal
import subprocess
import tarfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    for name in ['relay-ssh', 'key', 'public-ip', 'image', 'output']:
        p.add_argument('--'+name, required=True)
    p.add_argument('--port', type=int, default=24444)
    p.add_argument('--rounds', type=int, default=5)
    p.add_argument('--warmup', default='3s')
    p.add_argument('--duration', default='20s')
    args = p.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=False)
    binary = ROOT/'.artifacts/quic-diagnostics/bin'
    owner = 'orbis-quic-perf-diag-'+time.strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3)
    remote_dir = '/tmp/'+owner
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', args.key, args.relay_ssh]
    def remote(command, **kw):
        return subprocess.run([*ssh, shlex.join(command)], check=True, **kw)
    def save(name, value):
        (out/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    stage = out/'candidate'; stage.mkdir()
    shutil.copy2(binary/'diagnostic-linux', stage/'diagnostic-linux')
    shutil.copy2(ROOT/'native/relayquic/testdata/perf-remote-owner.py', stage/'perf-remote-owner.py')
    sources = list((ROOT/'native/relayquic/diagnostics').glob('*.go'))+list((ROOT/'native/relayquic/testdata/diagnostic').glob('*.go'))
    sources += [ROOT/'native/relayquic/go.mod', ROOT/'native/relayquic/go.sum', Path(__file__), binary/'diagnostic', binary/'diagnostic-linux']
    save('provenance.json', dict(owner=owner, publicIP=args.public_ip, port=args.port, rounds=args.rounds,
         warmup=args.warmup, duration=args.duration, image=args.image, phone=False, controller='upstream quic-go v0.65.0 NewReno',
         topology='Mac <-> actual public Relay, one raw leg, continuous verified bytes; not application/Relay throughput',
         hashes={str(f.relative_to(ROOT)): hashlib.sha256(f.read_bytes()).hexdigest() for f in sources}))
    archive = out/'candidate.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for f in stage.iterdir(): tar.add(f, arcname=f.name)
    remote(['mkdir', '-m', '755', remote_dir])
    try:
        with archive.open('rb') as data: remote(['tar', '-xz', '-C', remote_dir], stdin=data)
    except BaseException:
        remote(['rm', '-rf', '--', remote_dir]); raise
    token = secrets.token_hex(32)
    private = out/'private-config.json'; private.touch(mode=0o600); private.write_text(json.dumps({'token': token}))
    server = benchmark = None; stop_samples = threading.Event()
    cleanup = dict(owner=owner, released=False, errors=[])
    try:
        source = subprocess.check_output([*ssh, 'printf "%s\\n" "$SSH_CONNECTION"'], text=True, timeout=15).split()[0]
        save('network-before.json', network_snapshot(ssh, args.port))
        server_log = (out/'server.log').open('w')
        server = subprocess.Popen([*ssh, shlex.join(['python3', '-u', remote_dir+'/perf-remote-owner.py'])],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=server_log, text=True)
        messages = queue.Queue()
        def receive():
            with (out/'server.jsonl').open('w') as evidence:
                for line in server.stdout:
                    evidence.write(line); evidence.flush(); messages.put(line)
            messages.put(None)
        thread = threading.Thread(target=receive, daemon=True); thread.start()
        config = dict(owner=owner, role='diagnostic', port=args.port, sources=[source], ips=[args.public_ip], image=args.image, token=token)
        server.stdin.write(json.dumps(config)+'\n'); server.stdin.flush()
        line = messages.get(timeout=30)
        metadata = json.loads(line) if line else {}
        if metadata.get('type') != 'ready': raise RuntimeError('diagnostic service not ready')
        ca = out/'ca.pem'; ca.write_bytes(base64.b64decode(metadata['certificate']))
        save('server.json', {k: v for k, v in metadata.items() if k != 'certificate'})
        def interrupt(signum, frame):
            if benchmark is not None and benchmark.poll() is None: benchmark.send_signal(signal.SIGINT)
            raise KeyboardInterrupt()
        signal.signal(signal.SIGINT, interrupt); signal.signal(signal.SIGTERM, interrupt)
        command = [str(binary/'diagnostic'), '-address', args.public_ip+':'+str(args.port), '-ca', str(ca),
                   '-private-config', str(private), '-metrics', str(out/'client-metrics.jsonl'),
                   '-rounds', str(args.rounds), '-warmup', args.warmup, '-duration', args.duration]
        with (out/'raw.jsonl').open('w') as data, (out/'run.log').open('w') as log, (out/'resources.jsonl').open('w') as resources:
            benchmark = subprocess.Popen(command, stdout=data, stderr=log, env=dict(os.environ, GOMAXPROCS='2'))
            next_sample = 0
            while benchmark.poll() is None:
                process = subprocess.run(['ps', '-p', str(benchmark.pid), '-o', 'pid=,ppid=,rss=,pcpu=,comm='], capture_output=True, text=True)
                entry = {'time': time.time(), 'process': process.stdout.strip()}
                if time.monotonic() >= next_sample:
                    stat = subprocess.run([*ssh, shlex.join(['docker', 'stats', '--no-stream', '--format', '{{json .}}', owner])], capture_output=True, text=True, timeout=15)
                    entry['relayContainer'] = stat.stdout.strip(); entry['relaySampleExit'] = stat.returncode
                    next_sample = time.monotonic()+10
                resources.write(json.dumps(entry)+'\n'); resources.flush()
                stop_samples.wait(1)
        save('result.json', {'exitCode': benchmark.returncode, 'benchmarkPID': benchmark.pid})
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN); signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if benchmark is not None and benchmark.poll() is None:
            benchmark.send_signal(signal.SIGINT)
            try: benchmark.wait(timeout=10)
            except subprocess.TimeoutExpired: benchmark.kill(); benchmark.wait(); cleanup['errors'].append('local benchmark required kill')
        if server is not None:
            server.stdin.close()
            try: server.wait(timeout=25)
            except subprocess.TimeoutExpired: server.terminate(); server.wait(timeout=10); cleanup['errors'].append('server SSH required termination')
            thread.join(timeout=5); server_log.close()
            for line in (out/'server.jsonl').read_text().splitlines():
                message = json.loads(line)
                if message.get('type') == 'cleanup': cleanup.update(message)
            cleanup['sshExitCode'] = server.returncode
        private.unlink(missing_ok=True)
        try:
            with (out/'server-metrics.jsonl').open('w') as data:
                metrics = subprocess.run([*ssh, shlex.join(['cat', remote_dir+'/evidence/server-metrics.jsonl'])], stdout=data, stderr=subprocess.PIPE, text=True, timeout=20)
                if metrics.returncode: save('metrics-collection.json', {'available': False, 'reason': metrics.stderr.strip()})
            save('network-after.json', network_snapshot(ssh, args.port))
            check = remote_check(ssh, owner, args.port)
            cleanup.update(check)
            cleanup['released'] = bool(cleanup.get('released')) and not any(check.values()) and not cleanup['errors'] and cleanup.get('sshExitCode') == 0
            if cleanup['released']: remote(['rm', '-rf', '--', remote_dir], timeout=20)
            cleanup['remoteDirectoryRemaining'] = subprocess.run([*ssh, shlex.join(['test', '-e', remote_dir])], timeout=15).returncode != 1
            cleanup['privateConfigRemaining'] = private.exists()
            pid_check = subprocess.run(['ps', '-p', str(benchmark.pid), '-o', 'pid=,lstart=,comm='], capture_output=True, text=True) if benchmark else None
            cleanup['localProcessRemaining'] = bool(pid_check and pid_check.stdout.strip())
            cleanup['released'] &= not cleanup['remoteDirectoryRemaining'] and not cleanup['privateConfigRemaining'] and not cleanup['localProcessRemaining']
        except (subprocess.SubprocessError, OSError) as error:
            cleanup['released'] = False; cleanup['errors'].append('verification: '+type(error).__name__)
        cleanup['verifiedUTC'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save('cleanup.json', cleanup); print(json.dumps(cleanup), flush=True)
    if not cleanup['released']: raise RuntimeError('diagnostic cleanup-required')
    if benchmark and benchmark.returncode: raise SystemExit(benchmark.returncode)


def remote_check(ssh, owner, port):
    script = 'import json,subprocess; owner='+repr(owner)+'; port='+str(port)+'; print(json.dumps({"listenerRemaining":any(r.split()[4].endswith(":"+str(port)) for r in subprocess.check_output(["ss","-lntuH"],text=True).splitlines()),"containerRemaining":bool(subprocess.check_output(["docker","ps","-aq","--filter","name=^/"+owner+"$"],text=True).strip()),"firewallRuleRemaining":owner in subprocess.check_output(["ufw","status"],text=True)}))'
    return json.loads(subprocess.check_output([*ssh, shlex.join(['python3', '-c', script])], text=True, timeout=20))


def network_snapshot(ssh, port):
    script = 'import json,pathlib,subprocess; print(json.dumps({"udpSnmp":pathlib.Path("/proc/net/snmp").read_text(),"udpBuffers":subprocess.check_output(["sysctl","net.core.rmem_max","net.core.wmem_max"],text=True),"tcp":subprocess.check_output(["ss","-tin","( sport = :'+str(port)+' or dport = :'+str(port)+' )"],text=True)}))'
    return json.loads(subprocess.check_output([*ssh, shlex.join(['python3', '-c', script])], text=True, timeout=20))


if __name__ == '__main__':
    main()
