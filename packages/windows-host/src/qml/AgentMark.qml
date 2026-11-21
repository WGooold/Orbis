import QtQuick
import "AgentMarks.js" as AgentMarks

// Agent identity mark shared with the mobile apps. Sits inside the caller's icon slot so
// buttons and rows keep one optical size; the mark itself is inset to match symbol icons.
Item {
    id: mark
    property string kind: ""
    property color tint: Theme.agent(kind)
    readonly property string imageSource: AgentMarks.source(kind, tint, Theme.dark)
    readonly property bool hasMark: imageSource.length > 0
    implicitWidth: Theme.iconMd
    implicitHeight: Theme.iconMd
    Accessible.ignored: true
    Image {
        objectName: "agentMarkImage"
        anchors.centerIn: parent
        width: Math.min(mark.width, mark.height) * 0.9
        height: width
        sourceSize.width: width * Screen.devicePixelRatio
        fillMode: Image.PreserveAspectFit
        smooth: true
        source: mark.imageSource
        Accessible.ignored: true
    }
}
