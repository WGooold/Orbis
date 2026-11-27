#!/usr/bin/env python3
"""Build the pinned gomobile binding from source; output stays in app/build."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MOBILE = "v0.0.0-20261011034528-197770444867"


def source_fingerprint(go, root, env):
    # CI-PERF-10: reuse a cached relayquic.aar only when Go, NDK, helper script
    # and every module/source file under native/relayquic are byte-for-byte identical.
    digest = hashlib.sha256()
    toolchain = subprocess.check_output(
        [go, "env", "GOVERSION", "GOHOSTOS", "GOHOSTARCH"], env=env, text=True)
    ndk = Path(env.get("ANDROID_NDK_HOME", "")).name
    digest.update(f"{MOBILE}\n{toolchain}\nndk={ndk}\n".encode())
    tracked = [root / "scripts/build-relay-quic.py"]
    quic_dir = root / "native/relayquic"
    if quic_dir.is_dir():
        tracked.extend(sorted(path for path in quic_dir.rglob("*") if path.is_file()))
    for path in tracked:
        rel = path.relative_to(root).as_posix()
        digest.update(f"{rel}\0".encode())
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def prepare_tools(go, binary, env):
    # Upstream publishes source only. Restore the pinned binaries in CI and rebuild
    # them once only when either the mobile revision or host Go toolchain changes.
    fingerprint = MOBILE + "\n" + subprocess.check_output(
        [go, "env", "GOVERSION", "GOHOSTOS", "GOHOSTARCH"], env=env, text=True)
    stamp = binary / "toolchain.txt"
    suffix = ".exe" if os.name == "nt" else ""
    tools = [binary / (tool + suffix) for tool in ("gomobile", "gobind")]
    if stamp.is_file() and stamp.read_text() == fingerprint and all(tool.is_file() for tool in tools):
        return
    stamp.unlink(missing_ok=True)
    for tool in ("gomobile", "gobind"):
        subprocess.run([go, "install", f"golang.org/x/mobile/cmd/{tool}@{MOBILE}"], env=env, check=True)
    stamp.write_text(fingerprint)


def build_aar(go, output, binary, env, root=ROOT):
    stamp = output.with_name(output.name + ".stamp")
    fingerprint = source_fingerprint(go, root, env)
    if output.is_file() and output.stat().st_size > 0 and stamp.is_file() and stamp.read_text() == fingerprint:
        return False
    stamp.unlink(missing_ok=True)
    prepare_tools(go, binary, env)
    suffix = ".exe" if os.name == "nt" else ""
    subprocess.run([str(binary / ("gomobile" + suffix)), "bind", "-target=android", "-androidapi=26",
                    "-javapkg=orbis", "-trimpath", "-o", str(output), "./mobile"],
                   cwd=root / "native/relayquic", env=env, check=True)
    stamp.write_text(fingerprint)
    return True


def main():
    output = Path(sys.argv[1]).resolve()
    sdk = Path(sys.argv[2]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    local_go = ROOT / ".artifacts/toolchains/go/bin/go"
    go = os.environ.get("ORBIS_GO") or shutil.which("go") or str(local_go)
    binary = output.parent / "tools"
    binary.mkdir(exist_ok=True)
    env = dict(os.environ, GOBIN=str(binary), ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk))
    env["PATH"] = str(Path(go).resolve().parent) + os.pathsep + str(binary) + os.pathsep + env["PATH"]
    env.setdefault("ANDROID_NDK_HOME", str(sdk / "ndk/27.2.12479018"))
    build_aar(go, output, binary, env)

if __name__ == "__main__":
    main()
