# Orbis design QA

Source visual truth: [Orbis 交互稿.html](docs/design/Orbis%20交互稿.html) and [orbis-design-system.md](docs/design/orbis-design-system.md). The source screenshots used for the paired review are from the earlier capture at [design-alignment-20261108/site/comparison](.artifacts/design-alignment-20261108/site/comparison/); the reference files have since changed during this task.

Latest Android implementation screenshots: [.artifacts/orbis-android-refinements-20261109/final-instrumentation/device/device-files](.artifacts/orbis-android-refinements-20261109/final-instrumentation/device/device-files/). Paired comparisons: [.artifacts/orbis-android-refinements-20261109/design-qa-capture/pairs](.artifacts/orbis-android-refinements-20261109/design-qa-capture/pairs/).

The source capture is 358 × 812 CSS px. Android screenshots are 1080 × 2400 pixels at density 3, representing a 360 × 800 dp viewport. Comparison copies downsample Android at the native 3× density, align both views at the top, and pad the source screenshot by 1 px horizontally; neither view is cropped or stretched. The Android viewport is 12 dp shorter than the HTML reference.

Reviewed states: home list, new-session draft, providers, and settings, in the mist light theme. The full-view pairs show consistent navigation and surface treatment. The latest Android draft shows the selected Codex terminal version; settings use the shortened protocol row and a clear follow-system selection; the provider page no longer shows the removed instruction line and displays profile position. A focused-region comparison was not needed for these settled views; interactive menu and sheet states are covered by Android instrumentation and Relay browser tests.

Typography uses native platform fonts and spacing; the screenshots show small density and safe-area differences. Color tokens and neumorphic depth remain consistent. App imagery and Agent marks retain their native assets. Current copy follows the latest design-system instructions.

**Finding**

- [P2] The available HTML source screenshots predate the source edits made on 2026-11-09. In particular, the paired settings reference still shows the old follow-system switch, and the draft reference does not show the selected Codex version. Current implementation evidence and source text were reviewed, but an updated visual source capture could not be produced in this session because the desktop in-app browser bridge failed to return a tab. Capture the edited HTML at 358 × 812 and compare the same four states before marking visual QA passed.

No P0 or P1 implementation issue was found in the reviewed evidence. The P2 is a source-evidence gap, not a confirmed product mismatch.

Final result: blocked
