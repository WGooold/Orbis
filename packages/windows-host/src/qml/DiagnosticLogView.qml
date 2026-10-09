import QtQuick
import QtQuick.Controls
import Orbis.Host

Item {
    id: root
    required property var logModel
    property bool followingTail: true
    property bool removingRows: false
    // Keep the painted surface and text layout bounded independently of log volume.
    implicitHeight: 320
    NeuSurface { anchors.fill: parent; margin: 0; cornerRadius: 8; inset: true; surface: "#DDE3EF" }
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
            color: "#50617b"
            font.family: "Consolas"
            font.pixelSize: 12
        }
        Label { anchors.centerIn: parent; visible: list.count === 0; text: "暂无日志"; color: "#50617b" }
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
