# Third-party notices

Orbis original source code is available under the MIT license in [LICENSE](LICENSE).
Dependencies, toolchains and third-party artwork keep their own licenses.

- Windows distribution: [Qt, MinGW, Node.js and native dependency notices](packages/windows-host/THIRD-PARTY-NOTICES.md). Bundles include upstream licenses and an exact dependency inventory.
- Android agent icons: [source attribution](android/docs/agent-icons.md) and [bundled notices](android/app/src/main/assets/agent-icon-notices.txt).
- Android dependencies are declared in `android/app/build.gradle.kts`; the Gradle wrapper is provided by Gradle under Apache-2.0.
- JavaScript versions and sources are locked in `package-lock.json`; each package retains its upstream license. Packaging does not relicense those dependencies.
- Pi and Codex names identify supported integrations. This project is independently maintained.

Redistributions must preserve this file, the Orbis MIT license and the applicable dependency notices. Qt shared libraries remain replaceable; see the Windows build instructions for rebuilding and relinking the application.
