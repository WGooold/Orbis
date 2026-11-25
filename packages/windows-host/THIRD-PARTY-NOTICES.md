# Orbis Host: third-party components

Provider presets and native provider configuration behavior are adapted from [CC Switch](https://github.com/farion1231/cc-switch), revision `f8788719`, copyright (c) 2025 Jason Young, MIT licensed. Its license is included at `licenses/CC-Switch-MIT.txt`.

Claude Code provider presets, native configuration field ownership, and Claude/Codex subscription quota endpoint and credential conventions additionally reference revision `4ed071500b07ba5801be84c96ddb4e03bdf48a2d` of the same MIT-licensed project. Claude presets are reproduced by `scripts/import-claude-presets.mjs`.

OpenCode, OpenClaw, Hermes and Kimi Code provider presets and native configuration behavior additionally reference revision `fa4a237` of the same MIT-licensed project. These presets are reproduced by `scripts/import-ccswitch-native-presets.mjs`. All imported presets are limited to vendors, cloud platforms and local runtimes, with referral parameters removed (`scripts/curated-presets.mjs`).

This application uses unmodified Qt 6.8.3 shared libraries (Qt Core, GUI, Widgets, Network, QML, Quick, Quick Controls and SVG), distributed under the applicable LGPLv3 terms. Qt DLLs on Windows and frameworks on macOS remain dynamically linked and replaceable. License texts are in `licenses/` (under `Contents/Resources/` in the macOS app); the corresponding Qt source is available from https://download.qt.io/archive/qt/6.8/6.8.3/single/ and https://code.qt.io/.

Agent identity marks in `src/qml/AgentMarks.js` and `src/assets/agents/` use the same sources as the mobile apps. The MIT notices for Pi, Codex, Claude Code, Hermes Agent, OpenClaw and Kimi Code are in `licenses/Agent-Icons-MIT.txt`. The DeepSeek Harness favicon comes from `deepseek-harness` `dsh-v0.1.7-rc.1`. The OpenCode mark comes from the transparent light and dark logo files at https://opencode.ai/brand. "DeepSeek", "DeepSeek Harness" and the DeepSeek mark are trademarks of DeepSeek; "OpenCode" and its mark are trademarks of Anomaly. These marks identify the corresponding integrations, do not imply endorsement and are not covered by the MIT notices above.

Windows MinGW runtime licenses are in `licenses/mingw/`. Node.js and its bundled npm retain their license files under `runtime/node/`. JavaScript dependency names, exact versions and license identifiers are listed in `runtime/DEPENDENCIES.json`; each redistributed package retains its upstream license files. On macOS the runtime is under `Contents/Resources/`.

Orbis sources and build instructions: https://github.com/WGooold/Orbis. Orbis original code is MIT licensed; see the included LICENSE. Third-party terms remain unchanged. You may replace the dynamically linked Qt libraries and rebuild/relink this application, including for debugging modifications to those libraries.
