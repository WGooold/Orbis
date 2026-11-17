#!/usr/bin/env python3
"""Detach only a verified build-owned DMG mount, retrying transient busy errors."""
import argparse
import json
from pathlib import Path
import plistlib
import subprocess
import time


def run(command):
    return subprocess.run([str(value) for value in command], capture_output=True)


def mounted_image(image, mountpoint):
    result = run(['hdiutil', 'info', '-plist'])
    if result.returncode:
        raise RuntimeError('Cannot inspect mounted images: ' + result.stderr.decode(errors='replace'))
    matches = [entry for entry in plistlib.loads(result.stdout).get('images', [])
               if any(entity.get('mount-point') and Path(entity['mount-point']).resolve() == mountpoint
                      for entity in entry.get('system-entities', []))]
    if not matches:
        return False
    if len(matches) != 1 or Path(matches[0].get('image-path', '')).resolve() != image:
        raise RuntimeError(f'Refusing to detach a mount not owned by this image: {mountpoint}')
    return True


def detach(image, mountpoint, report_path):
    image, mountpoint = image.resolve(), mountpoint.resolve()
    report = dict(image=str(image), mountpoint=str(mountpoint), attempts=[], forced=False)
    try:
        delays = (2, 5, 10)
        for attempt in range(1, len(delays) + 2):
            # Recheck immediately before every detach, including the final force.
            if not mounted_image(image, mountpoint):
                report['status'] = 'unmounted'
                return
            result = run(['hdiutil', 'detach', mountpoint])
            diagnostic = (result.stdout + result.stderr).decode(errors='replace').strip()
            report['attempts'].append(dict(forced=False, exitCode=result.returncode, diagnostic=diagnostic))
            if result.returncode == 0:
                if mounted_image(image, mountpoint):
                    raise RuntimeError('hdiutil reported success but the owned mount is still active')
                report['status'] = 'unmounted'
                return
            if 'resource busy' not in diagnostic.lower():
                raise RuntimeError('DMG detach failed: ' + diagnostic)
            if attempt <= len(delays):
                print(f'Owned DMG is busy; retrying detach in {delays[attempt - 1]}s ({attempt}/4)', flush=True)
                time.sleep(delays[attempt - 1])
        if not mounted_image(image, mountpoint):
            report['status'] = 'unmounted'
            return
        # File copy and sync have already completed. Only this verified mount
        # can be forced; never enumerate or eject an unrelated device.
        result = run(['hdiutil', 'detach', '-force', mountpoint])
        diagnostic = (result.stdout + result.stderr).decode(errors='replace').strip()
        report['forced'] = True
        report['attempts'].append(dict(forced=True, exitCode=result.returncode, diagnostic=diagnostic))
        if result.returncode or mounted_image(image, mountpoint):
            raise RuntimeError('Owned DMG remains mounted after bounded detach attempts: ' + diagnostic)
        report['status'] = 'unmounted'
    except BaseException as error:
        report.update(status='failed', error=str(error))
        raise
    finally:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--mountpoint', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    detach(args.image, args.mountpoint, args.report)


if __name__ == '__main__':
    main()
