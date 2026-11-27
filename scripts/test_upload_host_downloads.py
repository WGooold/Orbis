"""CI-PERF-04: incremental Host archive creation, parallel SCP retries, and remote cleanup."""
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "upload_host_downloads",
    Path(__file__).resolve().parent.parent / "deploy/upload-host-downloads.py",
)
UPLOAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPLOAD)


class UploadHostDownloadsTests(unittest.TestCase):
    def test_incremental_archive_skips_remote_verified_binary_and_keeps_changed_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            win = root / "OrbisHost-0.1.25-windows-x64-setup.exe"
            mac = root / "OrbisHost-0.1.25-macos-arm64.dmg"
            win.write_bytes(b"windows-bytes")
            mac.write_bytes(b"macos-bytes")
            win_hash = hashlib.sha256(b"windows-bytes").hexdigest()
            mac_hash = hashlib.sha256(b"macos-bytes").hexdigest()
            (root / f"{win.name}.sha256").write_text(f"{win_hash}  {win.name}\n")
            (root / f"{mac.name}.sha256").write_text(f"{mac_hash}  {mac.name}\n")

            archive_path = root / "out.tar"
            summary = UPLOAD.build_incremental_archive(
                [win.name, mac.name],
                [root],
                {win.name: win_hash, mac.name: "0" * 64},
                archive_path,
            )
            self.assertEqual(summary["reused"], [win.name])
            self.assertEqual(summary["included"], [mac.name])
            with tarfile.open(archive_path, "r:") as archive:
                self.assertEqual(
                    sorted(archive.getnames()),
                    sorted([f"{win.name}.sha256", mac.name, f"{mac.name}.sha256"]),
                )

    def test_parallel_chunk_upload_retries_transient_scp_failure_and_verifies_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "orbis-downloads-abc123.tar"
            payload = b"A" * 50 + b"B" * 50 + b"C" * 25
            archive.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            scp_attempts = {}
            commands = []

            def fake_run(command, **_kwargs):
                commands.append(command)
                if command[0] == "scp":
                    part_name = Path(command[-2]).name
                    scp_attempts[part_name] = scp_attempts.get(part_name, 0) + 1
                    if part_name == "part-0001" and scp_attempts[part_name] == 1:
                        return subprocess.CompletedProcess(command, 1, "", "Connection reset by peer")
                return subprocess.CompletedProcess(command, 0, "", "")

            sleeps = []
            parts = UPLOAD.upload_archive(
                archive,
                digest,
                "root@example.test",
                "22",
                Path(temp) / "key",
                "/tmp/orbis-downloads-abc123.tar",
                workers=3,
                chunk_bytes=50,
                run=fake_run,
                sleep=sleeps.append,
            )
            self.assertEqual(parts, 3)
            self.assertEqual(scp_attempts["part-0001"], 2)
            self.assertEqual(sleeps, [2])
            self.assertTrue(all("ControlMaster=no" in cmd for cmd in commands))

    def test_failed_verification_cleans_remote_staging_and_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / "orbis-downloads-abc123.tar"
            archive.write_bytes(b"payload")
            digest = hashlib.sha256(b"payload").hexdigest()
            ssh_calls = []

            def fake_run(command, **kwargs):
                if command[0] == "ssh":
                    ssh_calls.append((command, kwargs.get("input", "")))
                    if "sha256sum" in kwargs.get("input", ""):
                        return subprocess.CompletedProcess(command, 1, "", "checksum mismatch")
                return subprocess.CompletedProcess(command, 0, "", "")

            with self.assertRaisesRegex(RuntimeError, "verification failed"):
                UPLOAD.upload_archive(
                    archive,
                    digest,
                    "root@example.test",
                    "22",
                    Path(temp) / "key",
                    "/tmp/orbis-downloads-abc123.tar",
                    workers=2,
                    chunk_bytes=4,
                    run=fake_run,
                    sleep=lambda _: None,
                )
            self.assertIn("rm -rf", ssh_calls[-1][0][-1])


if __name__ == "__main__":
    unittest.main()
