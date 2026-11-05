import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('raw_diag_summary', Path(__file__).with_name('summarize-native-quic-diagnostics.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class DiagnosticSummaryTests(unittest.TestCase):
    def test_incomplete_attempt_is_retained_and_not_zero_filled(self):
        rows = [dict(id=f'raw-{d}-01-{p}', direction=d, protocol=p, measurementComplete=True,
                     errors=[], goodputMbps=10) for d in ['download', 'upload'] for p in ['tls', 'quic']]
        rows[0].update(measurementComplete=False, errors=['EOF'], goodputMbps=2)
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory/'raw.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
            result = summary.summarize(directory, 1)
        self.assertTrue(result['allConfiguredAttemptsPresent'])
        self.assertFalse(result['allAttemptsPassed'])
        self.assertEqual(len(result['attempts']), 4)
        self.assertIsNone(result['groups'][0]['goodputMbps']['median'])
        self.assertEqual(result['groups'][0]['errors'], {'EOF': 1})

    def test_duplicate_attempt_cannot_satisfy_expected_rounds(self):
        row = dict(id='raw-download-01-tls', direction='download', protocol='tls',
                   measurementComplete=True, errors=[], goodputMbps=5)
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory/'raw.jsonl').write_text((json.dumps(row)+'\n')*2)
            result = summary.summarize(directory, 2)
        self.assertFalse(result['allConfiguredAttemptsPresent'])


if __name__ == '__main__':
    unittest.main()
