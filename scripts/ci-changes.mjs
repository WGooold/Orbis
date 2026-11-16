// CI-PERF-01: documentation still reports the CI gate without renting test runners.
export function classifyChanges(files) {
  const code = files.filter(path => !path.startsWith("docs/") && !/\.md$/iu.test(path));
  return {
    core: code.length > 0,
    ios: code.some(path => /^(ios\/|shared\/|scripts\/check-ios|\.github\/workflows\/)/u.test(path)),
    relay: code.some(path => /^(Dockerfile$|\.dockerignore$|package(?:-lock)?\.json$|tsconfig.*\.json$|packages\/|deploy\/|scripts\/(?:clean|build-relay-web)\.mjs$|scripts\/review-demo\/|\.github\/workflows\/(?:ci|core-checks|relay-deploy)\.yml$)/u.test(path)),
  };
}
