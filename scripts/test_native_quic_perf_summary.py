import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('quic_perf_summary', Path(__file__).with_name('summarize-native-quic-perf.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


def attempt(**changes):
    row = dict(scenario='download', protocol='quic', hostProtocol='quic', round=1, started='test',
               relayAuthMs=1, goodputMbps=4, probes=[{'rttMs': n} for n in range(1, 101)],
               drainComplete=True, completedChunks=30, errors=[], cleanup=True)
    return dict(row, **changes)


class SummaryTests(unittest.TestCase):
    def test_missing_responses_are_not_removed_to_improve_p95(self):
        probes = [{'rttMs': n} for n in range(1, 95)] + [{'rttMs': None}] * 6
        result = summary.summarize([attempt(probes=probes)], 1)['attempts'][0]
        self.assertEqual(result['latencyMs']['p50'], 50)
        self.assertIsNone(result['latencyMs']['p95'])
        self.assertEqual(result['probeScheduled'], 100)
        self.assertEqual(result['probeReplies'], 94)

    def test_failed_round_quantiles_remain_in_the_median(self):
        self.assertIsNone(summary.median_censored([500, 600, None, None, None]))
        self.assertEqual(summary.median_censored([500, 600, 700, None, None]), 700)

    def test_setup_failure_is_not_a_zero_throughput_sample(self):
        result = summary.summarize([attempt(relayAuthMs=0, probes=[], errors=['missing fixture metadata'], goodputMbps=0)], 1)
        group = next(g for g in result['groups'] if g['scenario'] == 'download' and g['protocol'] == 'quic')
        self.assertEqual(group['attempts'], 1)
        self.assertEqual(group['startedMeasurements'], 0)
        self.assertIsNone(group['goodputMbps']['median'])
        self.assertFalse(result['allAttemptsPassed'])

    def test_post_window_drain_failure_preserves_rate_and_failure(self):
        result = summary.summarize([attempt(errors=['bulk drain timeout'], drainComplete=False)], 1)
        row = result['attempts'][0]
        self.assertEqual(row['windowGoodputMbps'], 4)
        self.assertEqual(row['errors'], ['bulk drain timeout'])
        self.assertFalse(result['allAttemptsPassed'])
        self.assertFalse(summary.full_window(attempt(errors=['unexpected message: host.offline'])))

    def test_complete_requires_every_scenario_protocol_and_round(self):
        rows = [attempt(scenario=s, protocol=p, hostProtocol='ws' if p == 'wss' else 'quic')
                for s in ['idle', 'download', 'upload'] for p in ['wss', 'quic']]
        self.assertTrue(summary.summarize(rows, 1)['allAttemptsPassed'])
        self.assertFalse(summary.summarize(rows[:-1], 1)['allConfiguredRoundsPresent'])

    def test_explicit_window_marker_preserves_later_failure_without_guessing(self):
        self.assertTrue(summary.full_window(attempt(measurementComplete=True, errors=['unexpected message: host.offline'])))
        self.assertFalse(summary.full_window(attempt(measurementComplete=False, errors=[])))


if __name__ == '__main__':
    unittest.main()
