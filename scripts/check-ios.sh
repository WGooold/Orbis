#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_args=(--package-path "$repo_root/ios/Orbis" --disable-xctest)
developer_dir="$(xcode-select -p)"
testing_plugin="$developer_dir/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
if [[ -z "${ORBIS_TEST_NODE:-}" ]] && command -v node >/dev/null 2>&1; then
  export ORBIS_TEST_NODE="$(command -v node)"
fi

# Recent standalone Command Line Tools ship the Testing plugin but do not
# discover it automatically. Full Xcode supplies its own plugin search paths.
if [[ "$developer_dir" == */CommandLineTools && -f "$testing_plugin" ]]; then
  test_args+=(-Xswiftc -load-plugin-library -Xswiftc "$testing_plugin")
fi

swift test "${test_args[@]}"
swiftc -frontend -parse "$repo_root"/ios/Orbis/Orbis/*.swift
plutil -lint "$repo_root/ios/Orbis/Orbis/Info.plist"
plutil -lint "$repo_root/ios/Orbis/Orbis.xcodeproj/project.pbxproj"
xmllint --noout "$repo_root/ios/Orbis/Orbis.xcodeproj/xcshareddata/xcschemes/Orbis.xcscheme"

if [[ "$developer_dir" == */CommandLineTools ]]; then
  echo 'Core tests and source/configuration checks passed. The iOS app build requires full Xcode and an iOS Simulator SDK.'
else
  # Keep local simulator signing enabled so the installed app can access Keychain.
  xcodebuild -project "$repo_root/ios/Orbis/Orbis.xcodeproj" \
    -scheme Orbis -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$repo_root/ios/Orbis/build/DerivedData" \
    CODE_SIGN_IDENTITY=- build
  python3 "$repo_root/scripts/check-ios-bundle.py" \
    "$repo_root/ios/Orbis/build/DerivedData/Build/Products/Debug-iphonesimulator/Orbis.app"
fi
