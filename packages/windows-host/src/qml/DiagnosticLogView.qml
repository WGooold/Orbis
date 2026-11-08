import QtQuick
import QtQuick.Controls
import Orbis.Host

Item {
    id: root
    required property var logModel
    property color surfaceColor: "#e6ebf4"
    property color textColor: "#4a5364"
    property color highlightColor: "#ffffff"
    property color shadeColor: "#a6b2c6"
    property bool followingTail: true
    property bool removingRows: false
    // Keep the painted surface and text layout bounded independently of log volume.
    implicitHeight: 320
    NeuSurface { anchors.fill: parent; margin: 0; cornerRadius: 12; inset: true; surface: root.surfaceColor; highlightColor: root.highlightColor; shadeColor: root.shadeColor; shadowScale: 0.65 }
    ListView {
        id: list
        objectName: "diagnosticLogList"
        anchors.fill: parent
        anchors.margins: 12
        clip: true
        cacheBuffer: 0
        reuseItems: true
        model: root.logModel
        spacing: 6
        Component.onCompleted: positionViewAtEnd()
        onMovementEnded: root.followingTail = atYEnd
        ScrollBar.vertical: ScrollBar {}
        delegate: TextEdit {
            required property string logText
            objectName: "diagnosticLogRow"
            width: list.width - 14
            height: contentHeight
            text: logText
            textFormat: TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.Wrap
            color: root.textColor
            font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"
            font.pixelSize: 12
        }
        Label { anchors.centerIn: parent; visible: list.count === 0; text: "暂无日志"; color: root.textColor }
    }
    Connections {
        target: root.logModel
        function onRowsAboutToBeRemoved() { root.followingTail = list.atYEnd; root.removingRows = true }
        function onRowsAboutToBeInserted() { if (!root.removingRows) root.followingTail = list.atYEnd }
        function onRowsInserted() {
            root.removingRows = false
            if (root.followingTail) Qt.callLater(function() { list.positionViewAtEnd() })
        }
    }
}
