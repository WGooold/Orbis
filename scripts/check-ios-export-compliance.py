#!/usr/bin/env python3
"""Validate that the exact outgoing iOS bundle declares its encryption status."""
import argparse
import plistlib
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('plist', type=Path, help='Source or archived app Info.plist')
    parser.add_argument('--version')
    parser.add_argument('--build')
    args = parser.parse_args()
    with args.plist.open('rb') as handle:
        info = plistlib.load(handle)
    flag = info.get('ITSAppUsesNonExemptEncryption')
    if type(flag) is not bool:
        parser.exit(1, 'Set ITSAppUsesNonExemptEncryption to a reviewed Boolean before upload.\n')
    code = info.get('ITSEncryptionExportComplianceCode')
    if flag and not (isinstance(code, str) and code.strip() and '$' not in code):
        parser.exit(1, 'Non-exempt encryption: resolve Apple export compliance and include the applicable Apple code before automated upload.\n')
    if args.version is not None and info.get('CFBundleShortVersionString') != args.version:
        parser.exit(1, 'Archive marketing version does not match the requested version.\n')
    if args.build is not None and info.get('CFBundleVersion') != args.build:
        parser.exit(1, 'Archive build number does not match the requested build.\n')
    if (args.version is not None or args.build is not None) and info.get('CFBundleIdentifier') != 'com.orbising.orbis.ios':
        parser.exit(1, 'Archive bundle ID does not match production Orbis iOS.\n')
    print(f'Encryption declaration present (uses non-exempt encryption: {str(flag).lower()}).')


if __name__ == '__main__':
    main()
