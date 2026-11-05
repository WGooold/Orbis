#!/usr/bin/env python3
"""Aggregate all raw attempts, receiver windows and metadata without discarding failures."""
import argparse
import collections
import json
from pathlib import Path
import statistics


def summarize(directory, rounds):
    rows = [json.loads(line) for line in (directory/'raw.jsonl').read_text().splitlines() if line.strip()]
    groups = []
    complete = True
    for direction in ['download', 'upload']:
        for protocol in ['tls', 'quic']:
            group = [r for r in rows if r['direction'] == direction and r['protocol'] == protocol]
            expected = {f'raw-{direction}-{r:02d}-{protocol}' for r in range(1, rounds+1)}
            complete &= len(group) == rounds and {r['id'] for r in group} == expected
            valid = [r for r in group if r['measurementComplete'] and not r['errors']]
            values = [r['goodputMbps'] for r in valid]
            groups.append(dict(direction=direction, protocol=protocol, attempts=len(group), expectedAttempts=rounds,
                               validWindows=len(valid), goodputMbps=dict(median=statistics.median(values) if values else None,
                               min=min(values) if values else None, max=max(values) if values else None),
                               errors=dict(collections.Counter(e for r in group for e in r['errors']))))
    metadata = []
    for filename in ['client-metrics.jsonl', 'server-metrics.jsonl']:
        path = directory/filename
        if not path.exists(): continue
        entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        by_id = collections.defaultdict(list)
        for row in entries: by_id[row['connection']].append(row)
        for connection, samples in by_id.items():
            final = samples[-1]
            metadata.append(dict(file=filename, connection=connection, client=final['client'], final=final['final'],
                samples=len(samples), maxCwndBytes=max(r['cwndBytes'] for r in samples),
                maxFlightBytes=final['maxBytesInFlight'], maxPTO=final['maxPtoCount'],
                packetLostEvents=final['packetLostEvents'], packetsSent=final['packetSentEvents'],
                flowControlFrames=final['flowControlFrames'], congestionStates=final['congestionStates'],
                metadataValid=final['metricsEvents'] > 0 and final['packetSentEvents'] > 0))
    return dict(allConfiguredAttemptsPresent=bool(complete), allAttemptsPassed=bool(complete) and all(r['measurementComplete'] and not r['errors'] for r in rows),
                groups=groups, attempts=rows, transportMetadata=metadata,
                method='Receiver continuous verified bytes in its own fixed window. Incomplete attempts retained, never zero-filled. Metadata is sampled and aggregate event counts, not wire loss probability or time in each congestion state.')


def main():
    p = argparse.ArgumentParser(); p.add_argument('directory', type=Path); p.add_argument('--rounds', type=int, default=5); args = p.parse_args()
    result = summarize(args.directory, args.rounds)
    (args.directory/'summary.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'attempts'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
