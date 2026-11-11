"""Stage a verified Host download set, retaining platforms absent from this archive."""

import argparse
import hashlib
from pathlib import Path
import re
import shutil
import tarfile
import tempfile


NAME = re.compile(
    r"OrbisHost-\d+\.\d+\.\d+-(?P<platform>windows|macos)-"
    r"(?:x64-setup\.exe|x64\.zip|arm64\.dmg|x64\.dmg)(?:\.sha256)?"
)


def prepare(archive, previous, parent, release):
    parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=release + ".", dir=parent))
    try:
        selected = set()
        with tarfile.open(archive, "r:gz") as source:
            for member in source.getmembers():
                match = NAME.fullmatch(member.name)
                if not match or not member.isfile() or (staged / member.name).exists():
                    raise ValueError("Unexpected Host archive entry")
                selected.add(match["platform"])
                with source.extractfile(member) as incoming, (staged / member.name).open("wb") as target:
                    shutil.copyfileobj(incoming, target)
        if not selected:
            raise ValueError("Empty Host archive")
        if previous.is_dir():
            for old in previous.iterdir():
                match = NAME.fullmatch(old.name)
                if match and match["platform"] not in selected and old.is_file() and not old.is_symlink():
                    shutil.copyfile(old, staged / old.name)

        # Verify retained files as well as incoming ones before changing any serving pointer.
        for binary in staged.iterdir():
            if binary.name.endswith(".sha256"):
                continue
            checksum = binary.with_name(binary.name + ".sha256")
            fields = checksum.read_text().split()
            if len(fields) != 2 or fields[1] != binary.name:
                raise ValueError("Invalid Host checksum file")
            digest = hashlib.sha256()
            with binary.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != fields[0]:
                raise ValueError("Host SHA-256 mismatch")
        for checksum in staged.glob("*.sha256"):
            if not checksum.with_suffix("").is_file():
                raise ValueError("Host checksum has no binary")
        for file in staged.iterdir():
            file.chmod(0o644)
        staged.chmod(0o755)
        return staged
    except BaseException:
        shutil.rmtree(staged)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--previous", required=True, type=Path)
    parser.add_argument("--parent", required=True, type=Path)
    parser.add_argument("--release", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", args.release):
        parser.error("Invalid release id")
    print(prepare(args.archive, args.previous, args.parent, args.release).resolve())
