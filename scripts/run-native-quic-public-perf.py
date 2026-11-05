#!/usr/bin/env python3
"""Measure Host -> public Relay -> reference client using isolated test identities.
Consumes prebuilt candidates; never deploys to or modifies the production Relay.
"""
import argparse
import base64
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
    p.add_argument('--relay-ssh', required=True)
    p.add_argument('--key', required=True)
    p.add_argument('--public-ip', required=True)
    p.add_argument('--image', required=True)
    p.add_argument('--port', type=int, default=24443)
    p.add_argument('--output', required=True)
    p.add_argument('--rounds', type=int, default=5)
    p.add_argument('--duration', default='60s')
    p.add_argument('--warmup', default='10s')
    p.add_argument('--idle-duration', default='10s')
    p.add_argument('--drain', default='60s')
    p.add_argument('--node', required=True)
    p.add_argument('--binary-root', type=Path, default=ROOT/'.artifacts/quic-review/full-chain')
    p.add_argument('--helper', type=Path, default=ROOT/'.artifacts/quic-review/host-native/bin/orbis-quic-client')
    p.add_argument('--scenarios', default='idle,download,upload')
    p.add_argument('--diagnostics', action='store_true')
    p.add_argument('--workload', choices=['original', 'pipelined', 'compare', 'history-shared', 'history-background', 'history-compare'], default='original')
    args = p.parse_args()
    out = Path(args.output).resolve(); out.mkdir(parents=True, exist_ok=False)
    binary_root = args.binary_root.resolve()
    helper = args.helper.resolve()
    owner = 'orbis-quic-perf-' + time.strftime('%Y%m%d-%H%M%S') + '-' + secrets.token_hex(3)
    remote_dir = '/tmp/' + owner
    ssh = ['ssh','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-i',args.key,args.relay_ssh]
    def remote(command, **kw):
        return subprocess.run([*ssh, shlex.join(command)], check=True, **kw)
    def record(name, value):
        (out/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
    stage = out/'candidate'; stage.mkdir()
    for name in ['relay','protocol']:
        shutil.copytree(ROOT/f'packages/{name}/dist',stage/f'{name}-dist')
    for source in [binary_root/'perf-server-linux', ROOT/'native/relayquic/testdata/perf-server.mjs', ROOT/'native/relayquic/testdata/perf-remote-owner.py']:
        shutil.copy2(source, stage/source.name)
    os.chmod(stage/'perf-server-linux',0o755)
    provenance = {str(f.relative_to(stage)): hashlib.sha256(f.read_bytes()).hexdigest() for f in stage.rglob('*') if f.is_file()}
    local_files = [binary_root/'perf', helper,
        ROOT/'native/relayquic/testdata/perf/main.go', ROOT/'native/relayquic/testdata/perf-relay.mjs']
    for package in ['host', 'e2e']:
        local_files.extend((ROOT/f'packages/{package}/dist').rglob('*.js'))
    if args.diagnostics:
        local_files.extend((ROOT/'native/relayquic').rglob('*.go'))
        local_files.extend([Path(__file__),ROOT/'scripts/summarize-native-quic-perf.py'])
        for source in local_files:
            destination=out/'local-candidate'/source.relative_to(ROOT)
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,destination)
    record('provenance.json',{'owner':owner,'publicIP':args.public_ip,'port':args.port,'image':args.image,'candidate':provenance,
        'local': {str(f.relative_to(ROOT)): hashlib.sha256(f.read_bytes()).hexdigest() for f in local_files},
        'topology':'Mac Host -> public Relay -> Mac reference client (both public legs)',
        'protocols':'WSS/WSS versus QUIC/QUIC; same peer IP and port; isolated TLS root',
        'phone':False,'rounds':args.rounds,'duration':args.duration,'warmup':args.warmup,'drain':args.drain,
        'scenarios':args.scenarios,'diagnostics':args.diagnostics,'workload':args.workload})
    archive=out/'candidate.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
        for f in stage.iterdir(): tar.add(f,arcname=f.name)
    remote(['mkdir','-m','755',remote_dir])
    try:
        with archive.open('rb') as data:
            remote(['tar','-xz','-C',remote_dir],stdin=data)
        # Observed by the server, not inferred from a public IP lookup.
        source = subprocess.check_output([*ssh, 'printf "%s\\n" "$SSH_CONNECTION"'],text=True).split()[0]
    except BaseException:
        remote(['rm','-rf','--',remote_dir])
        record('cleanup.json',{'owner':owner,'released':True,'stage':'before remote service launch'})
        raise
    config=dict(owner=owner,role='server',port=args.port,sources=[source],ips=[args.public_ip],image=args.image,
        runtimeCredential=secrets.token_hex(24),credential=secrets.token_hex(24),diagnostics=args.diagnostics)
    server_log=(out/'server.log').open('w')
    server=subprocess.Popen([*ssh,shlex.join(['python3','-u',remote_dir+'/perf-remote-owner.py'])],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=server_log,text=True)
    messages=queue.Queue()
    def receive():
        for line in server.stdout:
            messages.put(line)
        messages.put(None)
    threading.Thread(target=receive,daemon=True).start()
    benchmark=None; cleanup={'owner':owner,'released':False}; private=out/'private-config.json'
    def interrupted(signum, frame):
        if benchmark is not None and benchmark.poll() is None: benchmark.send_signal(signal.SIGINT)
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,interrupted); signal.signal(signal.SIGINT,interrupted)
    try:
        server.stdin.write(json.dumps(config)+'\n');server.stdin.flush()
        line=messages.get(timeout=30)
        if line is None: raise RuntimeError('isolated server exited before ready; see server.log')
        metadata=json.loads(line)
        if 'certificate' not in metadata: raise RuntimeError('isolated server did not report ready')
        ca=out/'ca.pem';ca.write_bytes(base64.b64decode(metadata['certificate']))
        private.touch(mode=0o600)
        private.write_text(json.dumps(dict(relayUrl=f'wss://{args.public_ip}:{args.port}',quicPort=args.port,caFile=str(ca),
            helperPath=str(helper),
            runtimeCredential=config['runtimeCredential'],credential=config['credential'])))
        record('server.json',{k:v for k,v in metadata.items() if k!='certificate'})
        env=dict(os.environ,ORBIS_PERF_REMOTE_CONFIG=str(private),NODE_EXTRA_CA_CERTS=str(ca))
        if args.diagnostics:
            env.update(ORBIS_QUIC_DIAGNOSTICS_FILE=str(out/'client-metrics.jsonl'),ORBIS_PERF_PROGRESS=str(out/'host-progress.jsonl'))
        if args.workload == 'pipelined':
            env.update(ORBIS_PERF_CHUNK_BYTES='65536',ORBIS_PERF_UPLOAD_WINDOW_CHUNKS='64')
        env['ORBIS_PERF_WORKLOAD'] = args.workload
        command=[str(binary_root/'perf'),'-node',args.node,'-rounds',str(args.rounds),'-warmup',args.warmup,'-duration',args.duration,'-idle-duration',args.idle_duration,'-drain',args.drain,'-scenarios',args.scenarios]
        if args.workload == 'compare': command.extend(['-workloads','original,pipelined'])
        if args.workload == 'history-compare': command.extend(['-workloads','history-shared,history-background'])
        with (out/'raw.jsonl').open('w') as data,(out/'run.log').open('w') as log,(out/'resources.jsonl').open('w') as resources:
            benchmark=subprocess.Popen(command,cwd=ROOT/'native/relayquic',env=env,stdout=data,stderr=log)
            next_remote_sample = 0
            while benchmark.poll() is None:
                sample=subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,pcpu=,comm='],text=True)
                rows=[line.split(None,4) for line in sample.splitlines()]
                owned={benchmark.pid}
                for _ in range(5):
                    owned.update(int(row[0]) for row in rows if int(row[1]) in owned)
                entry={'time':time.time(),'processes':[row for row in rows if int(row[0]) in owned]}
                if time.monotonic() >= next_remote_sample:
                    try:
                        stat=subprocess.run([*ssh,shlex.join(['docker','stats','--no-stream','--format','{{json .}}',owner])],
                            capture_output=True,text=True,timeout=10)
                        entry['relayContainer']=stat.stdout.strip()
                        entry['relaySampleExit']=stat.returncode
                    except subprocess.TimeoutExpired:
                        entry['relaySampleError']='timeout'
                    next_remote_sample=time.monotonic()+10
                resources.write(json.dumps(entry)+'\n');resources.flush()
                time.sleep(1)
        record('result.json',{'exitCode':benchmark.returncode})
        print(f'Public-link measurement exit={benchmark.returncode}: {out}',flush=True)
    finally:
        # Once cleanup begins, a second Ctrl-C must not abandon owned remote resources.
        signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGINT,signal.SIG_IGN)
        if benchmark is not None and benchmark.poll() is None:
            benchmark.send_signal(signal.SIGINT)
            try: benchmark.wait(timeout=15)
            except subprocess.TimeoutExpired: benchmark.kill();benchmark.wait()
        server.stdin.close()
        try: server.wait(timeout=25)
        except subprocess.TimeoutExpired:
            server.terminate();server.wait(timeout=10)
        server_log.close()
        while True:
            try: line=messages.get(timeout=1)
            except queue.Empty: break
            if line is None: break
            try:
                message=json.loads(line)
                if message.get('type')=='cleanup': cleanup=message
            except json.JSONDecodeError: pass
        private.unlink(missing_ok=True)
        cleanup['sshExitCode']=server.returncode
        # Verify the container and listeners after the owner claims release.
        try:
            if args.diagnostics:
                with (out/'server-metrics.jsonl').open('w') as data:
                    collection=subprocess.run([*ssh,shlex.join(['cat',remote_dir+'/evidence/server-metrics.jsonl'])],stdout=data,stderr=subprocess.PIPE,text=True,timeout=20)
                    if collection.returncode: record('metrics-collection.json',{'available':False,'reason':collection.stderr.strip()})
            inspect=subprocess.check_output([*ssh,shlex.join(['ss','-lntuH'])],text=True,timeout=20)
            cleanup['listenersRemaining']=any(row.split()[4].endswith(':'+str(args.port)) for row in inspect.splitlines())
            containers=subprocess.check_output([*ssh,shlex.join(['docker','ps','-aq','--filter',f'name=^/{owner}$'])],text=True,timeout=20).strip()
            cleanup['containerRemaining']=bool(containers)
            firewall=subprocess.check_output([*ssh,'ufw status'],text=True,timeout=20)
            cleanup['firewallRuleRemaining']=owner in firewall
            cleanup['released']=bool(cleanup.get('released')) and not cleanup['listenersRemaining'] and not cleanup['containerRemaining'] and not cleanup['firewallRuleRemaining'] and server.returncode==0
            if cleanup['released']: remote(['rm','-rf','--',remote_dir],timeout=20)
        except (subprocess.SubprocessError, OSError) as error:
            cleanup['released']=False
            cleanup.setdefault('errors',[]).append('independent cleanup verification failed: '+type(error).__name__)
        record('cleanup.json',cleanup)
        print(json.dumps(cleanup),flush=True)
    if not cleanup['released']: raise RuntimeError('public fixture cleanup requires attention')
    if benchmark.returncode: raise SystemExit(benchmark.returncode)

if __name__=='__main__': main()
