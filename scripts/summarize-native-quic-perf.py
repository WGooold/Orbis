#!/usr/bin/env python3
"""Summarize every public-link attempt without dropping failed or missing probes."""
import argparse
import collections
import json
import math
from pathlib import Path
import re
import statistics


def quantile(values, fraction):
    if not values:
        return None
    value = sorted(values)[math.ceil(len(values) * fraction) - 1]
    return value if math.isfinite(value) else None


def median(values):
    return statistics.median(values) if values else None


def median_censored(values):
    if not values:
        return None
    value = statistics.median(math.inf if v is None else v for v in values)
    return value if math.isfinite(value) else None


def full_window(row):
    if 'measurementComplete' in row:
        return bool(row['measurementComplete'])
    # Harness v2 emits distinct errors for setup / active measurement / drain.
    # Only post-window failures may still contribute a full-window rate.
    if row.get('relayAuthMs', 0) <= 0 or not row.get('probes'):
        return False
    return all(re.fullmatch(r'(sender drain timeout|stop timeout|bulk drain timeout|\d+ measured control probes incomplete)', e)
               for e in row['errors'])


def summarize(rows, expected_rounds, scenarios=None):
    groups = collections.defaultdict(list)
    attempts = []
    for row in rows:
        probes = row.get('probes', [])
        values = [p['rttMs'] if p.get('rttMs') is not None else math.inf for p in probes]
        quantiles = {f'p{int(f * 100)}': quantile(values, f) for f in [.50, .95, .99]}
        result = {
            'scenario': row['scenario'], 'protocol': row['protocol'], 'hostProtocol': row['hostProtocol'],
            'hostTransportMatches': row['hostProtocol'] == ('ws' if row['protocol'] == 'wss' else 'quic'),
            'round': row['round'], 'started': row['started'],
            'fullMeasurementWindow': full_window(row),
            'windowGoodputMbps': row['goodputMbps'] if full_window(row) else None,
            'partialWindowGoodputMbps': row['goodputMbps'],
            'probeScheduled': len(probes), 'probeReplies': sum(math.isfinite(v) for v in values),
            'latencyMs': quantiles, 'drainComplete': row['drainComplete'],
            'completedChunksIncludingDrain': row['completedChunks'],
            'windowTransportBytes': row.get('windowTransportBytes'),
            'errors': row['errors'], 'cleanup': row['cleanup'],
        }
        attempts.append(result)
        groups[(row['scenario'], row['protocol'])].append(result)
    summary = []
    complete = True
    for scenario in scenarios or ['idle', 'download', 'upload']:
        for protocol in ['wss', 'quic']:
            group = groups[(scenario, protocol)]
            complete &= sorted(r['round'] for r in group) == list(range(1, expected_rounds + 1))
            rates = [r['windowGoodputMbps'] for r in group if r['fullMeasurementWindow']]
            measured = [r for r in group if r['probeScheduled']]
            summary.append({
                'scenario': scenario, 'protocol': protocol,
                'attempts': len(group), 'expectedAttempts': expected_rounds,
                'startedMeasurements': len(measured), 'fullMeasurementWindows': len(rates),
                'errorFreeAttempts': sum(not r['errors'] and r['cleanup'] and r['drainComplete'] for r in group),
                'goodputMbps': {'median': median(rates), 'min': min(rates) if rates else None, 'max': max(rates) if rates else None},
                'latencyMsMedianOfRoundQuantiles': {q: median_censored([r['latencyMs'][q] for r in measured]) for q in ['p50', 'p95', 'p99']},
                'probeScheduled': sum(r['probeScheduled'] for r in measured),
                'probeReplies': sum(r['probeReplies'] for r in measured),
                'errorCounts': dict(collections.Counter(e for r in group for e in r['errors'])),
            })
    return {'allConfiguredRoundsPresent': bool(complete),
            'allAttemptsPassed': bool(complete) and all(not r['errors'] and r['cleanup'] and r['drainComplete']
                and r['hostTransportMatches'] and r['fullMeasurementWindow']
                and 0 < r['probeScheduled'] == r['probeReplies'] for r in attempts),
            'method': 'Rate uses only complete fixed windows (including later drain failures). Setup/early measurement failures remain in attempts. Missing probe replies sort as infinity; null quantile means non-completion, never zero. Quantiles are nearest-rank per round, then medians across started rounds. Setup failures are reported separately.',
            'groups': summary, 'attempts': attempts}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--rounds', type=int, default=5)
    parser.add_argument('--scenarios', default='idle,download,upload')
    args = parser.parse_args()
    rows = [json.loads(line) for line in (args.directory/'raw.jsonl').read_text().splitlines() if line.strip()]
    result = summarize(rows, args.rounds, args.scenarios.split(','))
    (args.directory/'summary.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False)+'\n')
    print(json.dumps({k: result[k] for k in ['allConfiguredRoundsPresent', 'allAttemptsPassed', 'groups']}, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
