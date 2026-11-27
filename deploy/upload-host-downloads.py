#!/usr/bin/env python3
"""CI-PERF-04: build an incremental Host download tar and upload it via parallel SCP chunks."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import tarfile
import time

NAME = re.compile(
    r"OrbisHost-\d+\.\d+\.\d+-(?:windows|macos)-"
    r"(?:x64-setup\.exe|x64\.zip|arm64\.dmg|x64\.dmg)"
)
CHUNK_BYTES = 16 * 1024 * 1024


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ssh_base(port: str, key_file: Path) -> list[str]:
    return [
        "-i", str(key_file),
        "-o", "BatchMode=yes",
        "-o", "ControlMaster=no",
        "-o", "ControlPath=none",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=20",
    ] + (["-p", port] if port else [])


def scp_base(port: str, key_file: Path) -> list[str]:
    return [
        "-i", str(key_file),
        "-o", "BatchMode=yes",
        "-o", "ControlMaster=no",
        "-o", "ControlPath=none",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=20",
    ] + (["-P", port] if port else [])


def query_remote_verified_hashes(target: str, port: str, key_file: Path, app_dir: str, run=subprocess.run) -> dict[str, str]:
    remote_script = f"""
set -euo pipefail
dir=$(readlink -f {shlex.quote(app_dir)}/shared/downloads-current 2>/dev/null || true)
if [[ -z "$dir" || ! -d "$dir" ]]; then exit 0; fi
cd "$dir"
for sum in *.sha256; do
  [[ -f "$sum" ]] || continue
  bin="${{sum%.sha256}}"
  [[ -f "$bin" && ! -L "$bin" ]] || continue
  if sha256sum -c "$sum" >/dev/null 2>&1; then
    awk '{{print $1, $2}}' "$sum"
  fi
done
"""
    result = run(
        ["ssh", *ssh_base(port, key_file), target, "bash -s"],
        input=remote_script,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}
    verified: dict[str, str] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) == 2 and re.fullmatch(r"[a-f0-9]{64}", parts[0]) and NAME.fullmatch(parts[1]):
            verified[parts[1]] = parts[0]
    return verified


def build_incremental_archive(
    wanted: list[str],
    roots: list[Path],
    remote_hashes: dict[str, str],
    archive_path: Path,
) -> dict[str, object]:
    included_binaries: list[str] = []
    reused_binaries: list[str] = []
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    # Host assets (.dmg, .zip, setup.exe) are already compressed; an uncompressed tar avoids
    # burning runner CPU on redundant gzip passes while keeping exact single-file integrity.
    with tarfile.open(archive_path, "w:") as archive:
        for name in wanted:
            if not NAME.fullmatch(name):
                raise ValueError(f"Unexpected Host asset name: {name}")
            matches = [match for root in roots for match in root.rglob(name)]
            if len(matches) != 1:
                raise ValueError(f"Expected exactly one artifact for {name}, found {len(matches)}")
            binary = matches[0]
            checksum = binary.with_name(name + ".sha256")
            fields = checksum.read_text(encoding="utf-8").split()
            if len(fields) != 2 or fields[1] != name:
                raise ValueError(f"Invalid checksum file for {name}")
            digest = file_sha256(binary)
            if digest != fields[0]:
                raise ValueError(f"Checksum mismatch for {name}")
            archive.add(checksum, arcname=name + ".sha256")
            if remote_hashes.get(name) == digest:
                reused_binaries.append(name)
            else:
                archive.add(binary, arcname=name)
                included_binaries.append(name)
    return {
        "archive": str(archive_path),
        "bytes": archive_path.stat().st_size,
        "sha256": file_sha256(archive_path),
        "included": included_binaries,
        "reused": reused_binaries,
    }


def split_file(source: Path, directory: Path, chunk_bytes: int = CHUNK_BYTES) -> list[Path]:
    parts: list[Path] = []
    index = 0
    with source.open("rb") as stream:
        while True:
            data = stream.read(chunk_bytes)
            if not data:
                break
            part = directory / f"part-{index:04d}"
            part.write_bytes(data)
            parts.append(part)
            index += 1
    if not parts:
        part = directory / "part-0000"
        part.write_bytes(b"")
        parts.append(part)
    return parts


def upload_part(part: Path, target: str, port: str, key_file: Path, remote_dir: str, run=subprocess.run, sleep=time.sleep) -> None:
    delays = (2, 5, 10)
    destination = f"{target}:{remote_dir}/{part.name}"
    for attempt in range(1, len(delays) + 2):
        result = run(["scp", *scp_base(port, key_file), str(part), destination], capture_output=True, text=True)
        if result.returncode == 0:
            return
        if attempt > len(delays):
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"Failed to upload {part.name} after {attempt} attempts: {detail}")
        sleep(delays[attempt - 1])


def upload_archive(
    archive_path: Path,
    expected_sha256: str,
    target: str,
    port: str,
    key_file: Path,
    remote_archive: str,
    workers: int = 8,
    chunk_bytes: int = CHUNK_BYTES,
    run=subprocess.run,
    sleep=time.sleep,
) -> int:
    if not re.fullmatch(r"/tmp/orbis-downloads-[a-zA-Z0-9._-]+\.tar", remote_archive):
        raise ValueError(f"Unexpected remote archive path: {remote_archive}")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("Invalid archive SHA-256")
    remote_parts = f"{remote_archive}.parts"
    with tempfile.TemporaryDirectory(prefix="orbis-dl-parts-") as temp:
        parts = split_file(archive_path, Path(temp), chunk_bytes=chunk_bytes)
        setup = run(
            ["ssh", *ssh_base(port, key_file), target, f"rm -rf {shlex.quote(remote_parts)} {shlex.quote(remote_archive)} && install -d -m 700 {shlex.quote(remote_parts)}"],
            capture_output=True,
            text=True,
        )
        if setup.returncode != 0:
            raise RuntimeError(f"Cannot prepare remote upload staging: {setup.stderr.strip()}")
        try:
            # Independent SCP processes open separate TCP congestion windows across high-RTT links.
            pool_size = max(1, min(workers, len(parts)))
            with ThreadPoolExecutor(max_workers=pool_size) as executor:
                futures = [
                    executor.submit(upload_part, part, target, port, key_file, remote_parts, run, sleep)
                    for part in parts
                ]
                for future in as_completed(futures):
                    future.result()
            assemble = f"""
set -euo pipefail
cat {shlex.quote(remote_parts)}/part-* > {shlex.quote(remote_archive)}
actual=$(sha256sum {shlex.quote(remote_archive)} | awk '{{print $1}}')
test "$actual" = {shlex.quote(expected_sha256)}
rm -rf {shlex.quote(remote_parts)}
"""
            verify = run(
                ["ssh", *ssh_base(port, key_file), target, "bash -s"],
                input=assemble,
                capture_output=True,
                text=True,
            )
            if verify.returncode != 0:
                raise RuntimeError(f"Remote archive verification failed: {(verify.stderr or verify.stdout).strip()}")
        except BaseException:
            run(
                ["ssh", *ssh_base(port, key_file), target, f"rm -rf {shlex.quote(remote_parts)} {shlex.quote(remote_archive)}"],
                capture_output=True,
                text=True,
            )
            raise
        return len(parts)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cmake", type=Path, default=Path("packages/windows-host/CMakeLists.txt"))
    parser.add_argument("--windows-selected", action="store_true")
    parser.add_argument("--macos-selected", action="store_true")
    parser.add_argument("--root", dest="roots", action="append", type=Path, default=[])
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--remote-archive", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--port", default="22")
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    cmake_text = args.cmake.read_text(encoding="utf-8")
    match = re.search(r"project\(OrbisHost VERSION ([0-9]+\.[0-9]+\.[0-9]+)", cmake_text)
    if not match:
        raise RuntimeError("Host version not found in CMakeLists.txt")
    version = match.group(1)
    wanted: list[str] = []
    if args.windows_selected:
        wanted += [f"OrbisHost-{version}-windows-x64-setup.exe", f"OrbisHost-{version}-windows-x64.zip"]
    if args.macos_selected:
        wanted += [f"OrbisHost-{version}-macos-arm64.dmg", f"OrbisHost-{version}-macos-x64.dmg"]
    if not wanted:
        raise RuntimeError("No Host platforms selected for download upload")

    roots = [path for path in args.roots if path.is_dir()]
    remote_hashes = query_remote_verified_hashes(args.target, args.port, args.key_file, args.app_dir)
    summary = build_incremental_archive(wanted, roots, remote_hashes, args.archive)
    chunks = upload_archive(
        args.archive,
        str(summary["sha256"]),
        args.target,
        args.port,
        args.key_file,
        args.remote_archive,
        workers=args.workers,
    )
    print(
        f"Uploaded Host download archive ({summary['bytes']} bytes across {chunks} chunk(s)); "
        f"uploaded={len(summary['included'])}, reused_on_server={len(summary['reused'])}"
    )


if __name__ == "__main__":
    main()
