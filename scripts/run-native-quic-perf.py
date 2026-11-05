#!/usr/bin/env python3
"""Build and measure local WSS/native QUIC without mobile or global network changes."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GO_ROOT = ROOT / "native/relayquic"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def processes():
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,pcpu=,etime=,command="], text=True)
    result = {}
    for line in output.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) == 6:
            pid, ppid, rss, cpu, elapsed, command = parts
            result[int(pid)] = dict(pid=int(pid), ppid=int(ppid), rssKiB=int(rss), cpuPercent=float(cpu), elapsed=elapsed, command=command)
    return result


def tree(table, parent):
    ids = {parent}
    while True:
        added = {pid for pid, p in table.items() if p["ppid"] in ids} - ids
        if not added:
            return [table[pid] for pid in sorted(ids) if pid in table]
        ids |= added


def quantile(samples, q):
    if not samples:
        return None
    values = sorted(samples)
    return values[max(0, math.ceil(len(values) * q) - 1)]


def complete_median(values):
    values = list(values)
    return statistics.median(values) if all(v is not None for v in values) else None


def number(value):
    return f"{value:.2f}" if value is not None else "未完成"


def summarize(out, args):
    rows = [json.loads(line) for line in (out / "raw.jsonl").read_text().splitlines()]
    groups = {}
    invalid = []
    for row in rows:
        # Missing/failed probes remain in the denominator, never filtered into a
        # passing latency result. Successful percentiles are labeled as such.
        values = [p["rttMs"] for p in row["probes"] if p["rttMs"] is not None and not p.get("error")]
        expected = round(row["seconds"] * 10)
        row["latency"] = {
            "expected": expected, "recorded": len(row["probes"]), "successful": len(values),
            "failed": expected - len(values),
            "p50Ms": quantile(values, .5), "p95Ms": quantile(values, .95),
            "p99Ms": quantile(values, .99), "maxMs": max(values) if values else None,
        }
        if row["errors"] or not row["cleanup"] or not row["drainComplete"] or len(values) != expected:
            invalid.append([row["scenario"], row["round"], row["protocol"]])
        groups.setdefault((row["scenario"], row["protocol"]), []).append(row)
    aggregate = []
    for (scenario, protocol), values in groups.items():
        rates = [v["goodputMbps"] for v in values]
        aggregate.append(dict(
            scenario=scenario, protocol=protocol, rounds=len(values),
            medianMbps=statistics.median(rates), minMbps=min(rates), maxMbps=max(rates),
            medianMBps=statistics.median(rates) / 8,
            medianP50Ms=complete_median(v["latency"]["p50Ms"] for v in values),
            medianP95Ms=complete_median(v["latency"]["p95Ms"] for v in values),
            medianP99Ms=complete_median(v["latency"]["p99Ms"] for v in values),
            maxMs=max((v["latency"]["maxMs"] for v in values if v["latency"]["maxMs"] is not None), default=None),
            expectedProbes=sum(v["latency"]["expected"] for v in values),
            failedProbes=sum(v["latency"]["failed"] for v in values),
            payloadBytes=sum(v["payloadBytes"] for v in values),
            medianTransportReadyMs=statistics.median(v["transportReadyMs"] for v in values),
            medianRelayAuthMs=statistics.median(v["relayAuthMs"] for v in values),
        ))
    expected_runs = len(args.scenarios.split(",")) * args.rounds * 2
    summary = dict(expectedRuns=expected_runs, completedRuns=len(rows), invalidRuns=invalid,
                   valid=len(rows) == expected_runs and not invalid, aggregate=aggregate, runs=rows)
    write_json(out / "summary.json", summary)
    lines = ["| 场景 | 协议 | 有效吞吐中位数 Mbit/s（范围） | MB/s | ctl p50 / p95 / p99 ms（逐轮中位数） | 最慢 ms | 失败 / 应发探针 |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for row in aggregate:
        lines.append(f"| {row['scenario']} | {row['protocol']} | {row['medianMbps']:.2f} ({row['minMbps']:.2f}–{row['maxMbps']:.2f}) | {row['medianMBps']:.2f} | {number(row['medianP50Ms'])} / {number(row['medianP95Ms'])} / {number(row['medianP99Ms'])} | {number(row['maxMs'])} | {row['failedProbes']} / {row['expectedProbes']} |")
    (out / "table.md").write_text("\n".join(lines) + "\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--go", default=str(ROOT / ".artifacts/toolchains/go/bin/go"))
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--warmup", default="10s")
    parser.add_argument("--duration", default="60s")
    parser.add_argument("--idle-duration", default="10s")
    parser.add_argument("--scenarios", default="idle,download,upload")
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    guard = Path.home() / ".orbis/tools/ui-regression/resource_guard.py"
    if guard.exists():
        check = subprocess.run([sys.executable, str(guard), "check"], capture_output=True, text=True)
        (out / "memory-admission.json").write_text(check.stdout)
        check.check_returncode()
    with (out / "build.log").open("w") as log:
        subprocess.run([args.node, "node_modules/typescript/bin/tsc", "-b", "--pretty", "false"], cwd=ROOT, stdout=log, stderr=log, check=True)
        subprocess.run([args.go, "build", "-o", str(out / "perf"), "./testdata/perf"], cwd=GO_ROOT, stdout=log, stderr=log, check=True)
    paths = [p for folder in ("native/relayquic", "packages/relay/src", "packages/relay/dist", "packages/protocol/src", "packages/protocol/dist", "packages/e2e/src", "packages/e2e/dist")
             for p in (ROOT / folder).rglob("*") if p.is_file() and p.suffix in (".go", ".mod", ".sum", ".ts", ".js", ".mjs")]
    paths += [Path(__file__).resolve(), ROOT / "package-lock.json"]
    cmd = [str(out / "perf"), "--node", args.node, "--rounds", str(args.rounds), "--warmup", args.warmup,
           "--duration", args.duration, "--idle-duration", args.idle_duration, "--scenarios", args.scenarios]
    source = dict(command=cmd, cwd=str(GO_ROOT), system=platform.platform(),
                  head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                  branch=subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT, text=True).strip(),
                  node=subprocess.check_output([args.node, "--version"], text=True).strip(),
                  go=subprocess.check_output([args.go, "version"], text=True).strip(),
                  binarySHA256=sha(out / "perf"), hashes={str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)})
    if sys.platform == "darwin":
        source["hardware"] = subprocess.check_output(["sysctl", "machdep.cpu.brand_string", "hw.memsize", "hw.logicalcpu"], text=True).strip().splitlines()
    write_json(out / "provenance.json", source)
    observed = {}
    interrupted = False
    old_handlers = {}
    def on_signal(signum, _frame):
        nonlocal interrupted
        interrupted = True
        if process.poll() is None:
            process.send_signal(signum)
    with (out / "raw.jsonl").open("w") as raw, (out / "run.log").open("w") as log, (out / "resources.jsonl").open("w") as resources:
        process = subprocess.Popen(cmd, cwd=GO_ROOT, stdout=raw, stderr=log)
        for signum in (signal.SIGINT, signal.SIGTERM):
            old_handlers[signum] = signal.signal(signum, on_signal)
        try:
            while process.poll() is None:
                members = tree(processes(), process.pid)
                for p in members:
                    observed[p["pid"]] = p["command"]
                resources.write(json.dumps(dict(unixTime=time.time(), loadAverage=os.getloadavg(), processes=members)) + "\n")
                resources.flush()
                time.sleep(1)
            exit_code = process.wait()
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
            for signum, handler in old_handlers.items():
                signal.signal(signum, handler)
    # Also include short-lived Node fixture children from each result.
    for line in (out / "raw.jsonl").read_text().splitlines():
        row = json.loads(line)
        observed.setdefault(row["nodePid"], "testdata/perf-relay.mjs")
    table = processes()
    residual = [table[pid] for pid, command in observed.items() if pid in table and (table[pid]["command"] == command or "testdata/perf-relay.mjs" in table[pid]["command"])]
    cleanup = dict(exitCode=exit_code, interrupted=interrupted, observedPIDs=sorted(observed), residualProcesses=residual, released=not residual)
    write_json(out / "cleanup.json", cleanup)
    summary = summarize(out, args)
    print(json.dumps(dict(output=str(out), valid=summary["valid"], cleanup=cleanup), ensure_ascii=False))
    return 0 if exit_code == 0 and summary["valid"] and cleanup["released"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
