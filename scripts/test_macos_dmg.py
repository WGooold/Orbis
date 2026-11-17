"""Build cleanup must release its own busy mount while preserving other images."""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('macos_dmg', Path(__file__).with_name('macos-dmg.py'))
DMG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DMG)


class DmgDetachTests(unittest.TestCase):
    def exercise(self, normal_failures=0, error='Resource busy', changed_owner=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        image, mount, report = root / 'own.dmg', root / 'mount', root / 'report.json'
        state = dict(mounted=True, attempts=0)
        calls = []

        def run(command):
            command = [str(value) for value in command]
            calls.append(command)
            if command == ['hdiutil', 'info', '-plist']:
                path = root / 'unrelated.dmg' if changed_owner and state['attempts'] == 4 else image
                entities = [dict(**{'mount-point': str(mount), 'dev-entry': '/dev/disk99s2'})]
                images = [dict(**{'image-path': str(path), 'system-entities': entities})] if state['mounted'] else []
                return subprocess.CompletedProcess(command, 0, plistlib.dumps(dict(images=images)), b'')
            self.assertEqual(command[:2], ['hdiutil', 'detach'])
            self.assertEqual(command[-1], str(mount))
            state['attempts'] += 1
            failed = '-force' not in command and state['attempts'] <= normal_failures
            if not failed:
                state['mounted'] = False
            return subprocess.CompletedProcess(command, 16 if failed else 0, b'', error.encode() if failed else b'')
        return image, mount, report, state, calls, run

    def test_busy_mount_retries_normal_detach_without_force(self):
        # A transient scanner hold must not require a forced eject.
        image, mount, report, state, calls, run = self.exercise(normal_failures=1)
        with patch.object(DMG, 'run', side_effect=run), patch.object(DMG.time, 'sleep') as sleep:
            DMG.detach(image, mount, report)
        self.assertFalse(state['mounted'])
        self.assertEqual(state['attempts'], 2)
        self.assertFalse(any('-force' in command for command in calls))
        sleep.assert_called_once_with(2)
        self.assertEqual(json.loads(report.read_text())['status'], 'unmounted')

    def test_force_is_bounded_and_only_targets_reverified_own_mount(self):
        image, mount, report, state, calls, run = self.exercise(normal_failures=4)
        with patch.object(DMG, 'run', side_effect=run), patch.object(DMG.time, 'sleep') as sleep:
            DMG.detach(image, mount, report)
        self.assertEqual(state['attempts'], 5)
        self.assertEqual(sum('-force' in command for command in calls), 1)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 5, 10])
        self.assertTrue(json.loads(report.read_text())['forced'])

    def test_changed_mount_ownership_prevents_final_force(self):
        # A new image at the same pathname cannot inherit the previous mount's permission.
        image, mount, report, state, calls, run = self.exercise(normal_failures=4, changed_owner=True)
        with patch.object(DMG, 'run', side_effect=run), patch.object(DMG.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'not owned'):
                DMG.detach(image, mount, report)
        self.assertEqual(state['attempts'], 4)
        self.assertFalse(any('-force' in command for command in calls))
        self.assertEqual(json.loads(report.read_text())['status'], 'failed')

    def test_permanent_detach_error_never_retries_or_forces(self):
        image, mount, report, state, calls, run = self.exercise(normal_failures=4, error='Permission denied')
        with patch.object(DMG, 'run', side_effect=run), patch.object(DMG.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'Permission denied'):
                DMG.detach(image, mount, report)
        self.assertEqual(state['attempts'], 1)
        sleep.assert_not_called()
        self.assertFalse(any('-force' in command for command in calls))

    def test_already_unmounted_requires_no_detach(self):
        image, mount, report, state, calls, run = self.exercise()
        state['mounted'] = False
        with patch.object(DMG, 'run', side_effect=run):
            DMG.detach(image, mount, report)
        self.assertEqual(state['attempts'], 0)
        self.assertEqual(json.loads(report.read_text())['status'], 'unmounted')


if __name__ == '__main__':
    unittest.main()
