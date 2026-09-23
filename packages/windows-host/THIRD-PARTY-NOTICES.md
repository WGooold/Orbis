# Orbis Host: third-party components

This application uses unmodified Qt 6.8.3 shared libraries (Qt Core, GUI, Widgets, Network, QML, Quick, Quick Controls and SVG), distributed under the applicable LGPLv3 terms. Qt DLLs remain dynamically linked and replaceable. License texts are in `licenses/`; the corresponding Qt source is available from https://download.qt.io/archive/qt/6.8/6.8.3/single/ and https://code.qt.io/.

MinGW runtime licenses are in `licenses/mingw/`. Node.js and its bundled npm retain their license files under `runtime/node/`. JavaScript dependency names, exact versions and license identifiers are listed in `runtime/DEPENDENCIES.json`; each redistributed package retains its upstream license files. node-datachannel includes libdatachannel and uses MPL-2.0; its source is available from https://github.com/murat-dogan/node-datachannel.

Orbis sources and build instructions: https://github.com/WGooold/Orbis. Orbis original code is MIT licensed; see the included LICENSE. Third-party terms remain unchanged. You may replace the dynamically linked Qt DLLs and rebuild/relink this application, including for debugging modifications to those libraries.
