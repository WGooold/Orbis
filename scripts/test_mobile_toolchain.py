"""CI-PERF-02: cached tools must match the pinned source and Go host toolchain."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mobile_build", Path(__file__).with_name("build-relay-quic.py"))
mobile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mobile)


class MobileToolchainTests(unittest.TestCase):
    def test_reuses_matching_binaries_and_rebuilds_after_go_change_or_missing_tool(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory)
            suffix = ".exe" if mobile.os.name == "nt" else ""
            def install(command, **_kwargs):
                name = command[-1].split("/cmd/")[1].split("@")[0]
                (binary / (name + suffix)).write_text("fixture binary")
            with patch.object(mobile.subprocess, "check_output", return_value="go1.27.3\nlinux\namd64\n") as version, patch.object(mobile.subprocess, "run", side_effect=install) as run:
                mobile.prepare_tools("go", binary, {})
                self.assertEqual(run.call_count, 2)
                mobile.prepare_tools("go", binary, {})
                self.assertEqual(run.call_count, 2)
                version.return_value = "go1.27.4\nlinux\namd64\n"
                mobile.prepare_tools("go", binary, {})
                self.assertEqual(run.call_count, 4)
                (binary / ("gobind" + suffix)).unlink()
                mobile.prepare_tools("go", binary, {})
                self.assertEqual(run.call_count, 6)

    def test_failed_install_never_records_a_valid_toolchain(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory)
            with patch.object(mobile.subprocess, "check_output", return_value="go1.27.3\nlinux\namd64\n"), patch.object(mobile.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "go install")):
                with self.assertRaises(subprocess.CalledProcessError):
                    mobile.prepare_tools("go", binary, {})
                self.assertFalse((binary / "toolchain.txt").exists())


if __name__ == "__main__":
    unittest.main()
