import QtQuick
import "AgentMarks.js" as AgentMarks

// Agent identity mark shared with the mobile apps. Sits inside the caller's icon slot so
// buttons and rows keep one optical size; the mark itself is inset to match symbol icons.
Item {
    id: mark
    property string kind: ""
    property color tint: Theme.agent(kind)
    implicitWidth: Theme.iconMd
    implicitHeight: Theme.iconMd
    Image {
        anchors.centerIn: parent
        width: Math.min(mark.width, mark.height) * 0.9
        height: width
        sourceSize.width: width * Screen.devicePixelRatio
        sourceSize.height: width * Screen.devicePixelRatio
        smooth: true
        source: AgentMarks.source(mark.kind, mark.tint)
        Accessible.ignored: true
    }
}
