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

    def test_build_aar_skips_unchanged_inputs_and_rebuilds_on_source_or_ndk_change(self):
        # CI-PERF-10: cached relayquic.aar is reused only when Go, NDK and Go sources match.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "scripts/build-relay-quic.py").write_text("# helper\n")
            (root / "native/relayquic/mobile").mkdir(parents=True)
            source = root / "native/relayquic/mobile/bind.go"
            source.write_text("package mobile\n")
            output = root / "build/relayquic.aar"
            output.parent.mkdir(parents=True)
            binary = output.parent / "tools"
            binary.mkdir()
            suffix = ".exe" if mobile.os.name == "nt" else ""

            def fake_run(command, **_kwargs):
                cmd = [str(part) for part in command]
                if "install" in cmd:
                    name = cmd[-1].split("/cmd/")[1].split("@")[0]
                    (binary / (name + suffix)).write_text("tool")
                elif "bind" in cmd:
                    output.write_bytes(b"aar-bytes")

            env = {"ANDROID_NDK_HOME": "/sdk/ndk/27.2.12479018"}
            with patch.object(mobile.subprocess, "check_output", return_value="go1.27.3\nlinux\namd64\n"), \
                 patch.object(mobile.subprocess, "run", side_effect=fake_run) as run:
                self.assertTrue(mobile.build_aar("go", output, binary, env, root=root))
                binds_after_first = sum("bind" in [str(x) for x in c.args[0]] for c in run.call_args_list)
                self.assertEqual(binds_after_first, 1)

                # Identical inputs skip gomobile bind completely.
                self.assertFalse(mobile.build_aar("go", output, binary, env, root=root))
                binds_after_second = sum("bind" in [str(x) for x in c.args[0]] for c in run.call_args_list)
                self.assertEqual(binds_after_second, 1)

                # Any Go source edit invalidates the AAR stamp and triggers a fresh bind.
                source.write_text("package mobile // changed\n")
                self.assertTrue(mobile.build_aar("go", output, binary, env, root=root))
                binds_after_third = sum("bind" in [str(x) for x in c.args[0]] for c in run.call_args_list)
                self.assertEqual(binds_after_third, 2)

                # Changing NDK version also invalidates the AAR stamp.
                env_new_ndk = {"ANDROID_NDK_HOME": "/sdk/ndk/28.0.0"}
                self.assertTrue(mobile.build_aar("go", output, binary, env_new_ndk, root=root))
                binds_after_fourth = sum("bind" in [str(x) for x in c.args[0]] for c in run.call_args_list)
                self.assertEqual(binds_after_fourth, 3)


if __name__ == "__main__":
    unittest.main()
