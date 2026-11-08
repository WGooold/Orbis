import QtQuick
import Orbis.Host

Item {
    id: preview
    property bool dark: false
    property bool sage: Theme.sage
    readonly property color base: Theme.colorFor("surface-base", sage, dark)
    readonly property color lift: Theme.colorFor("surface-lift", sage, dark)
    readonly property color accent: Theme.colorFor("accent", sage, dark)
    readonly property color shade: Theme.colorFor("shade", sage, dark)
    readonly property color light: Theme.colorFor("highlight", sage, dark)
    implicitWidth: 160; implicitHeight: 112
    Rectangle { anchors.fill: parent; color: preview.base; radius: 12 }
    Rectangle { x: 12; y: 12; width: parent.width * 0.4; height: 4; radius: 2; color: preview.accent }
    Repeater {
        model: 2
        delegate: Item {
            required property int index
            x: 12; y: 30 + index * 28; width: preview.width - 24; height: 20
            NeuSurface { anchors.fill: parent; anchors.margins: -6; margin: 6; cornerRadius: 8; shadowScale: 0.4; surface: preview.base; highlightColor: preview.light; shadeColor: preview.shade }
            Rectangle { x: 8; y: 8; width: parent.width * 0.5; height: 4; radius: 2; color: preview.accent; opacity: 0.5 }
            Rectangle { visible: index === 0; width: 4; height: 4; radius: 2; x: parent.width - 12; y: 8; color: Theme.colorFor("success", preview.sage, preview.dark) }
        }
    }
    NeuSurface { x: 6; y: 80; width: preview.width - 12; height: 32; margin: 6; cornerRadius: 8; inset: true; shadowScale: 0.4; surface: preview.base; highlightColor: preview.light; shadeColor: preview.shade }
}
