import QtQuick
import QtQuick.Controls

// HOST-STATUS-ALIGN-01: a compact status label has one text line and one shared centerline.
Item {
    id: root
    property alias text: label.text
    property alias font: label.font
    property alias color: label.color
    property alias labelObjectName: label.objectName
    property alias dotColor: indicator.color
    property alias dotDiameter: indicator.diameter
    property alias idle: indicator.idle
    property alias syncing: indicator.syncing
    readonly property alias statusTruncated: label.truncated
    readonly property real spacing: 6

    implicitWidth: indicator.implicitWidth + spacing + label.implicitWidth
    implicitHeight: Math.max(indicator.implicitHeight, label.implicitHeight)

    StatusDot {
        id: indicator
        objectName: "statusDot"
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        anchors.alignWhenCentered: false
    }
    Label {
        id: label
        objectName: "statusText"
        anchors.left: indicator.right
        anchors.leftMargin: root.spacing
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.alignWhenCentered: false
        textFormat: Text.PlainText
        wrapMode: Text.NoWrap
        maximumLineCount: 1
        elide: Text.ElideRight
        padding: 0
        color: Theme.inkMuted
        font.pixelSize: Theme.label
    }
}
