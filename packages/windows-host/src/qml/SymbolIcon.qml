import QtQuick
import "Symbols.js" as Symbols

Item {
    id: icon
    property string name: ""
    property color color: Theme.inkMuted
    implicitWidth: Theme.iconMd
    implicitHeight: Theme.iconMd
    Image {
        anchors.centerIn: parent
        width: Math.min(icon.width, icon.height, Theme.iconMd); height: width
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: height * Screen.devicePixelRatio
        source: Symbols.paths[icon.name] ? "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="' + icon.color + '"><path d="' + Symbols.paths[icon.name] + '"/></svg>') : ""
    }
    Accessible.ignored: true
}
