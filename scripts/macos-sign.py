#!/usr/bin/env python3
"""Sign a deployed Host bundle, or notarize and staple its final DMG.

Credentials stay in a Keychain profile. Sign nested code from the inside out;
--deep is only a verification option. Reuse --submission-id after a wait times
out instead of uploading the same DMG again. Reports contain no credentials.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
MACHO_MAGIC = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
BUNDLES = {".app", ".framework", ".xpc", ".appex", ".plugin", ".bundle"}


def run(command, check=True):
    result = subprocess.run([str(arg) for arg in command], capture_output=True, text=True)
    if check and result.returncode:
        # Callers pass profile names, never credential values, in command arguments.
        raise RuntimeError(f"{command[0]} failed ({result.returncode}): "
                           f"{result.stdout}\n{result.stderr}")
    return result


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def signing_targets(app):
    targets = set()
    for directory, dirs, files in os.walk(app, followlinks=False):
        current = Path(directory)
        dirs[:] = [name for name in dirs if not (current / name).is_symlink()]
        for name in files:
            path = current / name
            if path.is_symlink():
                continue
            with path.open("rb") as source:
                if source.read(4) in MACHO_MAGIC:
                    targets.add(path)
        if current.suffix in BUNDLES:
            # Resource-only .bundle directories do not have executable code.
            if current.suffix == ".framework" or any(
                info.is_file() and plistlib.loads(info.read_bytes()).get("CFBundleExecutable")
                for info in (current / "Contents/Info.plist", current / "Info.plist")
            ):
                targets.add(current)
    targets.add(app)
    return sorted(targets, key=lambda path: (-len(path.parts), str(path)))


def identity(team, keychain=None):
    command = ["security", "find-identity", "-v", "-p", "codesigning"]
    if keychain:
        command.append(keychain)
    output = run(command).stdout
    found = re.findall(r'\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"\n]+)"', output)
    matches = [fingerprint for fingerprint, name in found if name.endswith(f"({team})")]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one valid Developer ID Application identity for {team}; "
                           f"found {len(matches)}")
    return matches[0]


def verify_identity(path, team, runtime=False):
    details = run(["codesign", "--display", "--verbose=4", path]).stderr
    if f"TeamIdentifier={team}\n" not in details or "Authority=Developer ID Application:" not in details:
        raise RuntimeError(f"Unexpected signing team or certificate: {path}")
    if runtime and not re.search(r"flags=.*\bruntime\b", details):
        raise RuntimeError(f"Hardened Runtime is missing: {path}")
    if "Timestamp=" not in details:
        raise RuntimeError(f"Secure timestamp is missing: {path}")
    return details


def sign_app(args):
    app = args.app.resolve()
    if app.suffix != ".app" or not (app / "Contents/Info.plist").is_file():
        raise RuntimeError("--app must be a deployed macOS .app bundle")
    signer = args.identity or identity(args.team_id, args.keychain)
    info_path = app / "Contents/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info.setdefault("NSAppleEventsUsageDescription", "Orbis opens agents in Terminal.")
    info_path.write_bytes(plistlib.dumps(info))
    targets = signing_targets(app)
    node = app / "Contents/Resources/runtime/node/node"
    if node not in targets:
        raise RuntimeError("Bundled Node executable is missing")
    entitlements = ROOT / "packages/windows-host/macos"
    print(f"Signing {len(targets)} code objects for {args.team_id}", flush=True)
    for index, target in enumerate(targets, 1):
        command = ["codesign", "--force", "--sign", signer, "--timestamp", "--options", "runtime"]
        if args.keychain:
            command += ["--keychain", args.keychain]
        if target == node:
            command += ["--entitlements", entitlements / "node.entitlements"]
        elif target == app:
            command += ["--entitlements", entitlements / "host.entitlements"]
        run([*command, target])
        if index % 20 == 0 or index == len(targets):
            print(f"Signed {index}/{len(targets)}", flush=True)
    run(["codesign", "--verify", "--deep", "--strict", app])
    for target in targets:
        verify_identity(target, args.team_id, runtime=True)
        ent = run(["codesign", "--display", "--entitlements", "-", "--xml", target]).stdout
        if ent.strip() and plistlib.loads(ent.encode()).get("com.apple.security.get-task-allow"):
            raise RuntimeError(f"Debugging entitlement is present: {target}")
    save(args.report, dict(status="signed-and-verified", teamId=args.team_id,
                           identity=signer, app=str(app),
                           targets=[str(path.relative_to(app)) for path in targets]))


def notarize_dmg(args):
    dmg = args.dmg.resolve()
    if dmg.suffix != ".dmg" or not dmg.is_file():
        raise RuntimeError("--dmg must be an existing disk image")
    auth = ["--keychain-profile", args.profile]
    if args.keychain:
        auth += ["--keychain", args.keychain]
    report = dict(dmg=str(dmg), teamId=args.team_id, status="preflight")
    if args.submission_id:
        # A pending submission refers to already signed bytes; never re-sign it.
        submission_id = args.submission_id
    else:
        signer = args.identity or identity(args.team_id, args.keychain)
        command = ["codesign", "--force", "--sign", signer, "--timestamp"]
        if args.keychain:
            command += ["--keychain", args.keychain]
        run([*command, dmg])
        submission_id = None
    run(["codesign", "--verify", "--strict", dmg])
    verify_identity(dmg, args.team_id)
    # Retain the signed input digest so a resumed wait cannot staple another file.
    digest = file_hash(dmg)
    if args.submission_id:
        previous = json.loads(args.report.read_text())
        if previous.get("submission", {}).get("id") != args.submission_id or previous.get("submittedSha256") != digest:
            raise RuntimeError("Submission ID or DMG hash differs from the saved report")
        report = previous
    report["submittedSha256"] = digest

    def request(command):
        result = run(["xcrun", "notarytool", *command, *auth, "--output-format", "json"], check=False)
        try:
            response = json.loads(result.stdout)
        except ValueError:
            report.update(status="request-error", error=result.stderr, response=result.stdout)
            save(args.report, report)
            raise RuntimeError("Notary service did not return JSON; see the saved report") from None
        if command[0] == "wait":
            response.setdefault("id", command[1])
        report.update(submission=response, status=response.get("status", "unknown"))
        save(args.report, report)
        return response

    if not submission_id:
        report["status"] = "submitting"
        save(args.report, report)
        submission = request(["submit", dmg])
        submission_id = submission.get("id")
        if not submission_id:
            raise RuntimeError("Notary service did not return a submission ID")
        print(f"Apple submission {submission_id}; waiting for notarization", flush=True)
    # Save the ID before polling, so interruption never requires a second upload.
    submission = request(["wait", submission_id, "--timeout", args.wait_timeout])
    if submission.get("status") != "Accepted":
        if submission.get("id") and submission.get("status") == "Invalid":
            log = run(["xcrun", "notarytool", "log", submission["id"], *auth], check=False)
            args.report.with_suffix(".apple-log.json").write_text(log.stdout or log.stderr)
        raise RuntimeError(f"Notarization is {report['status']}; see {args.report}. "
                           "Resume a pending submission with --submission-id.")
    run(["xcrun", "stapler", "staple", dmg])
    run(["xcrun", "stapler", "validate", dmg])
    run(["codesign", "--verify", "--strict", dmg])
    assessment = run(["spctl", "--assess", "--type", "open", "--context",
                      "context:primary-signature", "--verbose=2", dmg])
    report.update(status="notarized-stapled-and-assessed", sha256=file_hash(dmg),
                  gatekeeper=assessment.stderr.strip())
    save(args.report, report)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("identity", "sign-app", "notarize-dmg"):
        command = commands.add_parser(name)
        command.add_argument("--team-id", required=True)
        command.add_argument("--keychain", type=Path)
        if name == "identity":
            continue
        command.add_argument("--identity")
        command.add_argument("--report", type=Path, required=True)
        if name == "sign-app":
            command.add_argument("--app", type=Path, required=True)
        else:
            command.add_argument("--dmg", type=Path, required=True)
            command.add_argument("--profile", required=True)
            command.add_argument("--wait-timeout", default="25m")
            command.add_argument("--submission-id")
    args = parser.parse_args()
    if args.command == "identity":
        print(identity(args.team_id, args.keychain))
    elif args.command == "sign-app":
        sign_app(args)
    else:
        notarize_dmg(args)


if __name__ == "__main__":
    main()
