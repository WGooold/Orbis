# Third-party notices

Orbis original source code is available under the MIT license in [LICENSE](LICENSE).
Dependencies, toolchains and third-party artwork keep their own licenses.

- Windows distribution: [Qt, MinGW, Node.js and native dependency notices](packages/windows-host/THIRD-PARTY-NOTICES.md). Bundles include upstream licenses and an exact dependency inventory.
- Android agent icons: [source attribution](android/docs/agent-icons.md) and [bundled notices](android/app/src/main/assets/agent-icon-notices.txt).
- iOS P2P uses the WebRTC 140.0.0 XCFramework packaged by [stasel/WebRTC](https://github.com/stasel/WebRTC/tree/140.0.0), pinned as an exact Xcode Swift Package dependency. WebRTC retains the upstream BSD 3-Clause license and third-party notices; see [WebRTC license](https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE) and the [redistributed WebRTC license](ios/Orbis/THIRD-PARTY-NOTICES/WebRTC-LICENSE.txt). No camera or microphone tracks are created by Orbis.
- Android dependencies are declared in `android/app/build.gradle.kts`; the Gradle wrapper is provided by Gradle under Apache-2.0.
- JavaScript versions and sources are locked in `package-lock.json`; each package retains its upstream license. Packaging does not relicense those dependencies.
- Pi, Codex and DeepSeek names and marks identify supported integrations. This project is independently maintained and claims no endorsement, partnership or authorization from their owners.

Redistributions must preserve this file, the Orbis MIT license and the applicable dependency notices. Qt shared libraries remain replaceable; see the Windows build instructions for rebuilding and relinking the application.
