// CI-PERF-01: documentation still reports the CI gate without renting test runners.
// CI-PERF-07: native Qt/QML Host changes run a fast CMake/CTest gate in PR and main CI.
export function classifyChanges(files) {
  const paths = files.flatMap(file => typeof file === "string" ? [file] : [file.filename, file.previous_filename].filter(Boolean));
  const code = paths.filter(path => !path.startsWith("docs/") && !/\.md$/iu.test(path));
  return {
    core: code.length > 0,
    ios: code.some(path => /^(ios\/|shared\/|scripts\/check-ios|\.github\/workflows\/(?:ci|ci-pipeline|core-checks|ios-build)\.yml$)/u.test(path)),
    hostNative: code.some(path => /^(packages\/windows-host\/|scripts\/windows\/windows-host-build\.ps1$|\.github\/workflows\/(?:ci|ci-pipeline|macos-host-build|windows-host-build)\.yml$)/u.test(path)),
    relay: code.some(path => /^(Dockerfile$|\.dockerignore$|package(?:-lock)?\.json$|tsconfig.*\.json$|packages\/(?!windows-host\/)|deploy\/|scripts\/(?:clean|build-relay-web)\.mjs$|scripts\/review-demo\/|\.github\/workflows\/(?:ci|ci-pipeline|core-checks|relay-deploy)\.yml$)/u.test(path)),
  };
}
