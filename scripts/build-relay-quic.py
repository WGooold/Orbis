#!/usr/bin/env python3
"""Build the pinned gomobile binding from source; output stays in app/build."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
MOBILE = "v0.0.0-20261011034528-197770444867"

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
    suffix = ".exe" if os.name == "nt" else ""
    for tool in ("gomobile", "gobind"):
        subprocess.run([go, "install", f"golang.org/x/mobile/cmd/{tool}@{MOBILE}"], env=env, check=True)
    subprocess.run([str(binary / ("gomobile" + suffix)), "bind", "-target=android", "-androidapi=26",
                    "-javapkg=orbis", "-trimpath", "-o", str(output), "./mobile"],
                   cwd=ROOT / "native/relayquic", env=env, check=True)

if __name__ == "__main__":
    main()
