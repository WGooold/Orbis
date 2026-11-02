import QtQuick
import "Motion.js" as Motion

// One live accessible value; old glyphs exist only for the transition.
Item {
    id: label
    property string text: ""
    property bool roll: false
    property bool motionEnabled: typeof orbisMotionEnabled === "undefined" || orbisMotionEnabled
    property alias font: current.font
    property alias color: current.color
    property alias horizontalAlignment: current.horizontalAlignment
    property alias verticalAlignment: current.verticalAlignment
    property alias wrapMode: current.wrapMode
    property alias lineHeight: current.lineHeight
    property alias elide: current.elide
    property string shown: text
    property string previous: text
    property real progress: 1
    property int direction: 1
    property bool ready: false
    implicitWidth: current.implicitWidth
    implicitHeight: current.implicitHeight
    clip: true
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Component.onCompleted: { shown = text; previous = text; ready = true }
    onTextChanged: {
        if (!ready || text === shown) return
        movement.stop()
        previous = shown
        direction = Number(text) >= Number(shown) ? 1 : -1
        shown = text
        if (!motionEnabled) { progress = 1; return }
        progress = 0
        movement.start()
    }
    onMotionEnabledChanged: if (!motionEnabled) { movement.stop(); progress = 1 }
    NumberAnimation { id: movement; target: label; property: "progress"; from: 0; to: 1; duration: label.roll ? Motion.collectionDuration : Motion.stateDuration; easing.type: Easing.OutCubic }
    Text {
        width: parent.width; height: parent.height
        text: label.previous; font: current.font; color: current.color
        horizontalAlignment: current.horizontalAlignment; verticalAlignment: current.verticalAlignment
        wrapMode: current.wrapMode; elide: current.elide; lineHeight: current.lineHeight
        y: label.roll ? -label.direction * label.height * label.progress : 0
        opacity: 1 - label.progress; Accessible.ignored: true
    }
    Text {
        id: current
        width: parent.width; height: parent.height
        text: label.shown
        y: label.roll ? label.direction * label.height * (1 - label.progress) : 0
        opacity: label.progress; Accessible.ignored: true
    }
}
