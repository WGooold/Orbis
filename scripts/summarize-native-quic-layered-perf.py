#!/usr/bin/env python3
"""Summarize interleaved original/pipelined workloads without blending them."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('quic_perf_summary', Path(__file__).with_name('summarize-native-quic-perf.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


def main():
    p = argparse.ArgumentParser(); p.add_argument('directory', type=Path); p.add_argument('--rounds', type=int, default=3); args = p.parse_args()
    rows = [json.loads(line) for line in (args.directory/'raw.jsonl').read_text().splitlines() if line.strip()]
    result = dict(workloads={}, groups=[], attempts=[])
    for workload in ['original', 'pipelined']:
        chosen = [r for r in rows if r.get('workload') == workload]
        value = summary.summarize(chosen, args.rounds, ['download', 'upload'])
        result['workloads'][workload] = {k: value[k] for k in ['allConfiguredRoundsPresent', 'allAttemptsPassed']}
        result['groups'].extend(dict(g, workload=workload) for g in value['groups'])
        result['attempts'].extend(dict(r, workload=workload) for r in value['attempts'])
    result['allConfiguredAttemptsPresent'] = all(v['allConfiguredRoundsPresent'] for v in result['workloads'].values())
    result['allAttemptsPassed'] = all(v['allAttemptsPassed'] for v in result['workloads'].values())
    result['method'] = 'Same Relay service; loads and protocols interleaved within each round. Original 1 MiB + single upload in flight versus 64 KiB + up to 4 MiB in flight. Both retain production E2E/framing. Received JSON frame bytes are not authenticated payload goodput.'
    (args.directory/'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'attempts'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
