# Orbis Host: third-party components

Provider presets and native provider configuration behavior are adapted from [CC Switch](https://github.com/farion1231/cc-switch), revision `f8788719`, copyright (c) 2025 Jason Young, MIT licensed. Its license is included at `licenses/CC-Switch-MIT.txt`.

Claude Code provider presets, native configuration field ownership, and Claude/Codex subscription quota endpoint and credential conventions additionally reference revision `4ed071500b07ba5801be84c96ddb4e03bdf48a2d` of the same MIT-licensed project. Claude presets are reproduced by `scripts/import-claude-presets.mjs`.

This application uses unmodified Qt 6.8.3 shared libraries (Qt Core, GUI, Widgets, Network, QML, Quick, Quick Controls and SVG), distributed under the applicable LGPLv3 terms. Qt DLLs on Windows and frameworks on macOS remain dynamically linked and replaceable. License texts are in `licenses/` (under `Contents/Resources/` in the macOS app); the corresponding Qt source is available from https://download.qt.io/archive/qt/6.8/6.8.3/single/ and https://code.qt.io/.

Agent identity marks in `src/qml/AgentMarks.js` use the same sources as the mobile apps: the Pi mark (https://pi.dev/logo-auto.svg, copyright (c) 2025 Mario Zechner), the Codex and Claude marks from Lobe Icons (https://github.com/lobehub/lobe-icons, copyright (c) 2023 LobeHub), all MIT licensed, and the DeepSeek Harness favicon from `deepseek-harness` `dsh-v0.1.7-rc.1`. "DeepSeek", "DeepSeek Harness" and the DeepSeek mark are trademarks of DeepSeek; the mark only identifies the DeepSeek Harness agent Orbis connects to and is not covered by the MIT license above. The MIT permission notice for the Pi, Codex and Claude marks is reproduced in `licenses/Agent-Icons-MIT.txt`.

Windows MinGW runtime licenses are in `licenses/mingw/`. Node.js and its bundled npm retain their license files under `runtime/node/`. JavaScript dependency names, exact versions and license identifiers are listed in `runtime/DEPENDENCIES.json`; each redistributed package retains its upstream license files. On macOS the runtime is under `Contents/Resources/`.

Orbis sources and build instructions: https://github.com/WGooold/Orbis. Orbis original code is MIT licensed; see the included LICENSE. Third-party terms remain unchanged. You may replace the dynamically linked Qt libraries and rebuild/relink this application, including for debugging modifications to those libraries.
