"""APNS-L15: prevent optimization/signing mismatches and stale re-signing metadata."""
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("ios_push_environment", Path(__file__).with_name("ios-push-environment.py"))
PUSH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUSH)
ROOT = Path(__file__).resolve().parents[1]


class PushEnvironmentTests(unittest.TestCase):
    def test_development_override_and_distribution_use_their_signing_files(self):
        # Reuse one output to catch stale metadata when the signing file changes.
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "Release-iphoneos/Orbis.app"
            for name, expected in [("Debug", "development"), ("Release", "production"), ("Debug", "development")]:
                PUSH.write_environment(app, ROOT / f"ios/Orbis/Orbis/Orbis.{name}.entitlements")
                self.assertEqual(plistlib.loads((app / PUSH.RESOURCE).read_bytes()), {"aps-environment": expected})

    def test_disabled_capability_clears_old_metadata_and_invalid_value_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "Orbis.app"
            PUSH.write_environment(app, ROOT / "ios/Orbis/Orbis/Orbis.Debug.entitlements")
            PUSH.write_environment(app, "")
            self.assertEqual(plistlib.loads((app / PUSH.RESOURCE).read_bytes()), {})
            invalid = Path(temporary) / "invalid.entitlements"
            invalid.write_bytes(plistlib.dumps({"aps-environment": "sandbox"}))
            with self.assertRaises(ValueError):
                PUSH.write_environment(app, invalid)
            with self.assertRaises(FileNotFoundError):
                PUSH.write_environment(app, invalid.with_name("missing.entitlements"))

    def test_final_signature_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "Orbis.app"
            PUSH.write_environment(app, ROOT / "ios/Orbis/Orbis/Orbis.Debug.entitlements")
            for environment in ("development", "production", None):
                entitlements = {} if environment is None else {"aps-environment": environment}
                result = subprocess.CompletedProcess([], 0, stdout=plistlib.dumps(entitlements))
                with patch.object(PUSH.subprocess, "run", return_value=result):
                    if environment == "development":
                        self.assertEqual(PUSH.verify_environment(app), "development")
                    else:
                        with self.assertRaisesRegex(ValueError, "environment mismatch"):
                            PUSH.verify_environment(app)


if __name__ == "__main__":
    unittest.main()
