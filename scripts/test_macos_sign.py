"""Prevent omitted native modules, accidental debug permissions and false notarization success."""
import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("macos_sign", Path(__file__).with_name("macos-sign.py"))
SIGN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SIGN)


class SigningTests(unittest.TestCase):
    def test_nested_code_and_extensionless_binaries_precede_containers(self):
        # Qt symlinks must not cause duplicate signatures or escape the app tree.
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "Host.app"
            framework = app / "Contents/Frameworks/QtCore.framework"
            binary = framework / "Versions/A/QtCore"
            addon = app / "Contents/Resources/runtime/native.node"
            helper = app / "Contents/Resources/runtime/quic"
            outside = Path(temporary) / "outside"
            for path in (binary, addon, helper, outside):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bytes.fromhex("cffaedfe") + bytes(64))
            (framework / "QtCore").symlink_to("Versions/A/QtCore")
            (app / "outside").symlink_to(outside)
            targets = SIGN.signing_targets(app)
            self.assertIn(addon, targets)
            self.assertIn(helper, targets)
            self.assertLess(targets.index(binary), targets.index(framework))
            self.assertEqual(targets[-1], app)
            self.assertNotIn(app / "outside", targets)
            self.assertNotIn(framework / "QtCore", targets)

    def test_identity_rejects_development_and_wrong_team(self):
        result = subprocess.CompletedProcess([], 0, stdout=(
            '1) ' + 'A' * 40 + ' "Apple Development: user (TEAM123456)"\n'
            '2) ' + 'B' * 40 + ' "Developer ID Application: user (OTHER12345)"\n'))
        with patch.object(SIGN, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "found 0"):
                SIGN.identity("TEAM123456")

    def test_entitlements_do_not_enable_debugging_or_broaden_host_loading(self):
        # The bundled Node has broader native-module needs than the Qt process.
        directory = SIGN.ROOT / "packages/windows-host/macos"
        host = plistlib.loads((directory / "host.entitlements").read_bytes())
        node = plistlib.loads((directory / "node.entitlements").read_bytes())
        for values in (host, node):
            self.assertFalse(values.get("com.apple.security.get-task-allow", False))
        self.assertNotIn("com.apple.security.cs.disable-library-validation", host)
        self.assertTrue(node["com.apple.security.cs.disable-library-validation"])

    def test_codesign_retries_missing_timestamp_with_unchanged_command(self):
        # Preserve the exact signing identity, keychain, entitlements and runtime
        # flags when Apple's timestamp service fails after signing a code object.
        command = ["codesign", "--force", "--sign", "identity", "--timestamp", "--options", "runtime",
                   "--keychain", "private-keychain", "--entitlements", "node.entitlements", "node"]
        failed = subprocess.CompletedProcess(command, 1, stdout="", stderr="A timestamp was expected but was not found.")
        succeeded = subprocess.CompletedProcess(command, 0, stdout="", stderr="")
        with patch.object(SIGN, "run", side_effect=[failed, succeeded]) as run, \
             patch.object(SIGN.time, "sleep") as sleep:
            self.assertIs(SIGN.run_codesign(command), succeeded)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertEqual(call.args, (command,))
            self.assertEqual(call.kwargs, {"check": False})
        sleep.assert_called_once_with(5)

    def test_codesign_does_not_retry_invalid_identity(self):
        # A permanent credential failure must not be mistaken for a service outage.
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="The specified item could not be found in the keychain.")
        with patch.object(SIGN, "run", return_value=failed) as run, patch.object(SIGN.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "after 1 attempt.*keychain"):
                SIGN.run_codesign(["codesign", "--sign", "identity", "--timestamp", "Host.app"])
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    def test_codesign_timestamp_retries_are_bounded(self):
        # A timestamp outage cannot turn the signing job into an unbounded wait.
        failed = subprocess.CompletedProcess([], 1, stdout="", stderr="The timestamp service is not available.")
        with patch.object(SIGN, "run", return_value=failed) as run, patch.object(SIGN.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "after 4 attempt"):
                SIGN.run_codesign(["codesign", "--sign", "identity", "--timestamp", "Host.dmg"])
        self.assertEqual(run.call_count, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10, 20])

    def exercise_notary(self, status):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        dmg = Path(directory.name) / "Host.dmg"
        report = Path(directory.name) / "notarization.json"
        dmg.write_bytes(b"signed-dmg")
        args = argparse.Namespace(dmg=dmg, report=report, profile="test", keychain=None,
                                  team_id="TEAM123456", identity="identity",
                                  submission_id=None, wait_timeout="1s")
        calls = []

        def run(command, check=True):
            command = [str(value) for value in command]
            calls.append(command)
            output = ""
            if command[:3] == ["xcrun", "notarytool", "submit"]:
                output = json.dumps(dict(id="submission-id", status="Uploaded"))
            if command[:3] == ["xcrun", "notarytool", "wait"]:
                # Submission ID must be persisted before the potentially long wait.
                self.assertEqual(json.loads(report.read_text())["submission"]["id"], "submission-id")
                output = json.dumps(dict(id="submission-id", status=status))
            if command[:3] == ["xcrun", "stapler", "staple"]:
                dmg.write_bytes(b"signed-dmg-with-ticket")
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr="accepted")

        return args, calls, run

    def test_final_hash_is_after_stapling_and_gatekeeper(self):
        args, calls, run = self.exercise_notary("Accepted")
        with patch.object(SIGN, "run", side_effect=run), patch.object(SIGN, "verify_identity"):
            SIGN.notarize_dmg(args)
        report = json.loads(args.report.read_text())
        self.assertEqual(report["status"], "notarized-stapled-and-assessed")
        self.assertEqual(report["sha256"], SIGN.file_hash(args.dmg))
        self.assertNotEqual(report["sha256"], report["submittedSha256"])
        self.assertEqual(calls[-1][0], "spctl")

    def test_stapler_retries_transient_cloudkit_network_failure(self):
        args, calls, normal = self.exercise_notary("Accepted")
        failed_staple = False

        def run(command, check=True):
            nonlocal failed_staple
            if command[:3] == ["xcrun", "stapler", "staple"] and not failed_staple:
                failed_staple = True
                calls.append(command)
                return subprocess.CompletedProcess(command, 68, stdout="", stderr=(
                    'NSURLErrorDomain Code=-1005 "The network connection was lost."'))
            return normal(command, check=check)

        with patch.object(SIGN, "run", side_effect=run), patch.object(SIGN.time, "sleep") as sleep, \
             patch.object(SIGN, "verify_identity"):
            SIGN.notarize_dmg(args)
        report = json.loads(args.report.read_text())
        self.assertEqual(report["status"], "notarized-stapled-and-assessed")
        self.assertEqual(report["stapler"]["staple"], {"status": "success", "attempts": 2})
        self.assertEqual(report["stapler"]["validate"], {"status": "success", "attempts": 1})
        sleep.assert_called_once_with(5)

    def test_rejection_never_staples_or_claims_success(self):
        args, calls, run = self.exercise_notary("Invalid")
        with patch.object(SIGN, "run", side_effect=run), patch.object(SIGN, "verify_identity"):
            with self.assertRaisesRegex(RuntimeError, "Invalid"):
                SIGN.notarize_dmg(args)
        self.assertFalse(any(command[1:2] == ["stapler"] for command in calls))
        self.assertTrue(args.report.with_suffix(".apple-log.json").is_file())

    def test_resume_refuses_changed_dmg_before_waiting(self):
        # A saved Apple submission must remain bound to its actual uploaded bytes.
        args, calls, run = self.exercise_notary("In Progress")
        with patch.object(SIGN, "run", side_effect=run), patch.object(SIGN, "verify_identity"):
            with self.assertRaisesRegex(RuntimeError, "In Progress"):
                SIGN.notarize_dmg(args)
            args.submission_id = "submission-id"
            args.dmg.write_bytes(b"different-image")
            calls.clear()
            with self.assertRaisesRegex(RuntimeError, "hash differs"):
                SIGN.notarize_dmg(args)
        self.assertFalse(any(command[0] == "xcrun" for command in calls))

    def test_wait_timeout_on_stderr_reads_actual_processing_status(self):
        # Real notarytool emits its timeout JSON on stderr, without a status.
        args, calls, normal = self.exercise_notary("In Progress")

        def run(command, check=True):
            if command[:3] == ["xcrun", "notarytool", "wait"]:
                calls.append(command)
                return subprocess.CompletedProcess(command, 69, stdout="", stderr=json.dumps(
                    dict(id="submission-id", message="Timeout of 1500 second(s) was reached")))
            if command[:3] == ["xcrun", "notarytool", "info"]:
                calls.append(command)
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps(
                    dict(id="submission-id", status="In Progress")), stderr="")
            return normal(command, check=check)

        with patch.object(SIGN, "run", side_effect=run), patch.object(SIGN, "verify_identity"):
            with self.assertRaisesRegex(RuntimeError, "In Progress"):
                SIGN.notarize_dmg(args)
        report = json.loads(args.report.read_text())
        self.assertEqual(report["submission"]["id"], "submission-id")
        self.assertEqual(report["status"], "In Progress")
        self.assertIn("Timeout", report["waitDiagnostic"]["message"])

    def test_successful_resume_does_not_resign_or_upload_again(self):
        # A completed pending submission can be stapled without replacing its bytes.
        args, calls, pending = self.exercise_notary("In Progress")
        with patch.object(SIGN, "run", side_effect=pending), patch.object(SIGN, "verify_identity"):
            with self.assertRaisesRegex(RuntimeError, "In Progress"):
                SIGN.notarize_dmg(args)
        args.submission_id = "submission-id"
        calls.clear()
        saved = json.loads(args.report.read_text())
        saved.update(error="previous timeout", response="")
        args.report.write_text(json.dumps(saved))

        def accepted(command, check=True):
            result = pending(command, check=check)
            if command[:3] == ["xcrun", "notarytool", "wait"]:
                result.stdout = json.dumps(dict(id="submission-id", status="Accepted"))
            return result

        with patch.object(SIGN, "run", side_effect=accepted), patch.object(SIGN, "verify_identity"):
            SIGN.notarize_dmg(args)
        self.assertFalse(any(command[:3] == ["xcrun", "notarytool", "submit"] for command in calls))
        self.assertFalse(any("--force" in command for command in calls))
        report = json.loads(args.report.read_text())
        self.assertEqual(report["status"], "notarized-stapled-and-assessed")
        self.assertNotIn("error", report)


if __name__ == "__main__":
    unittest.main()
