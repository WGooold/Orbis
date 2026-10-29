#!/usr/bin/env python3
"""Check app-local dyld dependencies without Xcode's injected framework paths."""

import plistlib
import subprocess
import sys
from pathlib import Path


def load_commands(binary):
    output = subprocess.run(
        ["otool", "-l", str(binary)], check=True, capture_output=True, text=True
    ).stdout
    paths, dependencies = [], []
    command = None
    for line in output.splitlines():
        fields = line.strip().split()
        if fields[:1] == ["cmd"]:
            command = fields[1]
        elif command == "LC_RPATH" and fields[:1] == ["path"]:
            paths.append(line.strip()[5:].rsplit(" (offset ", 1)[0])
        elif command in {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB"} and fields[:1] == ["name"]:
            dependencies.append(line.strip()[5:].rsplit(" (offset ", 1)[0])
    return paths, dependencies


def check_bundle(app):
    with (app / "Info.plist").open("rb") as stream:
        executable = app / plistlib.load(stream)["CFBundleExecutable"]
    visited = set()

    def expand(value, loader):
        return Path(value.replace("@executable_path", str(app)).replace("@loader_path", str(loader.parent)))

    def visit(binary, inherited):
        binary = binary.resolve()
        if binary in visited:
            return
        visited.add(binary)
        paths, dependencies = load_commands(binary)
        search = [expand(path, binary) for path in paths] + inherited
        for dependency in dependencies:
            if dependency.startswith(("/System/Library/", "/usr/lib/")):
                continue
            if dependency.startswith("@rpath/"):
                suffix = dependency[len("@rpath/"):]
                candidates = [path / suffix for path in search]
                # Swift runtime libraries may be supplied by the target OS.
                if suffix.startswith("libswift") and any(str(path) == "/usr/lib/swift" for path in search):
                    continue
            else:
                candidates = [expand(dependency, binary)]
            resolved = next(
                (path for path in candidates if path.is_file() and app in path.resolve().parents), None
            )
            if resolved is None:
                tried = ", ".join(str(path) for path in candidates) or "no runtime search paths"
                raise RuntimeError(f"{binary.name}: unresolved {dependency}; tried {tried}")
            visit(resolved, search)

    visit(executable, [])
    print(f"App-local runtime dependencies resolved: {app} ({len(visited)} binaries)")


if __name__ == "__main__":
    try:
        check_bundle(Path(sys.argv[1]).resolve())
    except (IndexError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f"iOS bundle check failed: {error}")
