#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Several suites block on semaphores while they wait for background I/O. Run them
# one at a time: in parallel on a small runner the blocked workers starve the
# cooperative pool, and waits that never get their signal time out.
package_args=(--package-path "$repo_root/ios/Orbis")
developer_dir="$(xcode-select -p)"
testing_plugin="$developer_dir/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
if [[ -z "${ORBIS_TEST_NODE:-}" ]] && command -v node >/dev/null 2>&1; then
  export ORBIS_TEST_NODE="$(command -v node)"
fi

# Recent standalone Command Line Tools ship the Testing plugin but do not
# discover it automatically. Full Xcode supplies its own plugin search paths.
if [[ "$developer_dir" == */CommandLineTools && -f "$testing_plugin" ]]; then
  package_args+=(-Xswiftc -load-plugin-library -Xswiftc "$testing_plugin")
fi

mode="${1:-all}"
case "$mode" in
  prepare-tests)
    swift build "${package_args[@]}" --build-tests
    exit
    ;;
  tests)
    swift test "${package_args[@]}" --skip-build --disable-xctest --no-parallel
    exit
    ;;
  all)
    swift test "${package_args[@]}" --disable-xctest --no-parallel
    ;;
  app) ;;
  *) echo "Usage: $0 [all|prepare-tests|tests|app]" >&2; exit 2 ;;
esac

swiftc -frontend -parse "$repo_root"/ios/Orbis/Orbis/*.swift
plutil -lint "$repo_root/ios/Orbis/Orbis/Info.plist"
plutil -lint "$repo_root/ios/Orbis/Orbis.xcodeproj/project.pbxproj"
xmllint --noout "$repo_root/ios/Orbis/Orbis.xcodeproj/xcshareddata/xcschemes/Orbis.xcscheme"

if [[ "$developer_dir" == */CommandLineTools ]]; then
  echo 'Core tests and source/configuration checks passed. The iOS app build requires full Xcode and an iOS Simulator SDK.'
else
  # Keep local simulator signing enabled so the installed app can access Keychain.
  build_args=(CODE_SIGN_IDENTITY=-)
  if [[ -n "${ORBIS_IOS_SIMULATOR_ARCH:-}" ]]; then
    build_args+=("ARCHS=$ORBIS_IOS_SIMULATOR_ARCH" ONLY_ACTIVE_ARCH=NO)
  fi
  xcodebuild -project "$repo_root/ios/Orbis/Orbis.xcodeproj" \
    -scheme Orbis -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$repo_root/ios/Orbis/build/DerivedData" \
    "${build_args[@]}" build
  python3 "$repo_root/scripts/check-ios-bundle.py" \
    "$repo_root/ios/Orbis/build/DerivedData/Build/Products/Debug-iphonesimulator/Orbis.app"
fi
