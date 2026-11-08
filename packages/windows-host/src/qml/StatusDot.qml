import QtQuick

Item {
    id: root
    property color color: Theme.inkFaint
    property bool idle: false
    property bool syncing: false
    implicitWidth: 16; implicitHeight: 16
    Rectangle {
        anchors.centerIn: parent
        width: root.syncing ? 6 : 8; height: width; radius: width / 2
        color: root.idle ? "transparent" : root.color
        border.width: root.idle ? 1.5 : 0; border.color: root.color
    }
    Canvas {
        id: arc
        anchors.centerIn: parent; width: 16; height: 16; visible: root.syncing
        onPaint: {
            var ctx = getContext("2d")
            ctx.clearRect(0, 0, width, height)
            ctx.lineWidth = 1.5; ctx.lineCap = "round"
            for (var i = 0; i < 20; i++) {
                ctx.strokeStyle = Qt.alpha(root.color, (i + 1) / 20)
                ctx.beginPath(); ctx.arc(8, 8, 6.5, i * 0.2, (i + 1) * 0.2); ctx.stroke()
            }
        }
        RotationAnimator on rotation { from: 0; to: 360; duration: Theme.durLoop; loops: Animation.Infinite; running: root.syncing && Theme.motionEnabled }
        Connections { target: root; function onColorChanged() { arc.requestPaint() } }
    }
    Accessible.ignored: true
}
