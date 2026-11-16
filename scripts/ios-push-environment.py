#!/usr/bin/env python3
"""Bind the app's APNs registration environment to its signing entitlements.

Xcode writes the selected signing entitlement into a small bundled plist. Packaging
checks compare it with the final signature, including after archive export.
"""
import argparse
import plistlib
import subprocess
from pathlib import Path

RESOURCE = "OrbisPushEnvironment.plist"


def write_environment(app, entitlements):
    values = plistlib.loads(Path(entitlements).read_bytes()) if entitlements else {}
    environment = values.get("aps-environment")
    if environment is not None and environment not in ("development", "production"):
        raise ValueError("Invalid aps-environment signing entitlement")
    result = {} if environment is None else {"aps-environment": environment}
    app.mkdir(parents=True, exist_ok=True)
    (app / RESOURCE).write_bytes(plistlib.dumps(result))


def verify_environment(app):
    metadata = plistlib.loads((app / RESOURCE).read_bytes()).get("aps-environment")
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(app)],
        check=True, capture_output=True,
    )
    signed = plistlib.loads(result.stdout).get("aps-environment") if result.stdout.strip() else None
    if signed != metadata:
        raise ValueError(f"APNs environment mismatch: bundled={metadata!r}, signed={signed!r}")
    return signed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("write", "verify"))
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--entitlements", default="")
    args = parser.parse_args()
    if args.action == "write":
        write_environment(args.app, args.entitlements)
    else:
        print(f"APNs signing environment verified: {verify_environment(args.app)}")
