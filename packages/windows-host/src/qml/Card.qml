import QtQuick
import QtQuick.Controls
import Orbis.Host

Pane {
    readonly property int orbisSurfaceLevel: 0
    padding: 16
    background: Surface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: Theme.radiusLg }
}
