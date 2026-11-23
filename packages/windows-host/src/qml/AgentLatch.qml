import QtQuick
import QtQuick.Controls
import Orbis.Host

// AGENT-DIAL-01: the bolt follows the receipt, not an early policy broadcast.
AbstractButton {
    id: latch
    property bool powered: false
    property var change: null
    property bool failed: false
    property bool large: false
    readonly property int boltSize: large ? 30 : 24
    readonly property int dotSize: 6
    onFailedChanged: if (failed && Theme.motionEnabled) shake.restart()
    property color tint: Theme.accent
    property real nudge: hovered && enabled && !change ? (powered ? -5 : 5) : 0
    readonly property real position: change ? (change.target ? 0.66 : 0.33) : powered ? 1 : 0
    implicitWidth: large ? 76 : 60
    implicitHeight: large ? 38 : 30
    hoverEnabled: true
    Accessible.role: Accessible.CheckBox
    Accessible.checkable: true
    Accessible.checked: powered
    Accessible.description: change ? (change.queued ? "已排队" : "待确认") : powered ? "已启用" : "未启用"
    ToolTip.visible: hovered
    ToolTip.delay: 300
    ToolTip.text: change ? (change.withdrawable ? "撤回排队" : change.queued ? "已排队" : "待确认") : powered ? "停用" : "启用"
    background: Surface {
        anchors.fill: parent; margin: 3; cornerRadius: height / 2; inset: true
        shadowScale: 0.4; focused: latch.activeFocus; hovered: latch.hovered && latch.enabled
        disabled: !latch.enabled && !latch.change
    }
    contentItem: Item {
        Rectangle {
            x: parent.width - latch.boltSize - 3; y: (parent.height - latch.boltSize) / 2
            width: latch.boltSize; height: latch.boltSize; radius: latch.boltSize / 2
            color: "transparent"
            border.width: latch.powered || latch.failed ? 1.5 : 1
            border.color: latch.failed ? Theme.danger : latch.powered ? latch.tint : Theme.hairline
        }
        Item {
            id: bolt
            x: 3 + (parent.width - latch.boltSize - 6) * latch.position + latch.nudge
            y: (parent.height - latch.boltSize) / 2
            width: latch.boltSize; height: latch.boltSize
            transform: Translate { id: recoil }
            SequentialAnimation {
                id: shake
                NumberAnimation { target: recoil; property: "x"; to: -3; duration: 55 }
                NumberAnimation { target: recoil; property: "x"; to: 2; duration: 55 }
                NumberAnimation { target: recoil; property: "x"; to: 0; duration: 70 }
            }
            Behavior on x { enabled: Theme.motionEnabled; NumberAnimation { duration: Theme.durState; easing.type: Easing.OutCubic } }
            Surface { anchors.fill: parent; cornerRadius: latch.boltSize / 2; margin: 4; shadowScale: 0.45; visible: !latch.change; inset: latch.down; disabled: !latch.enabled }
            Rectangle { anchors.centerIn: parent; width: latch.dotSize; height: latch.dotSize; radius: latch.dotSize / 2; color: latch.powered ? latch.tint : Theme.inkFaint; visible: !latch.change }
            Canvas {
                id: ring
                anchors.fill: parent
                visible: !!latch.change
                onVisibleChanged: requestPaint()
                onPaint: {
                    const ctx = getContext("2d")
                    ctx.clearRect(0, 0, width, height)
                    if (!latch.change) return
                    ctx.lineWidth = 1.5; ctx.strokeStyle = Theme.accent; ctx.lineCap = "round"
                    const segments = latch.change.queued ? 8 : 1
                    const r = width / 2 - 2
                    for (let i = 0; i < segments; ++i) {
                        const angle = i * Math.PI / 4
                        ctx.beginPath(); ctx.arc(width / 2, height / 2, r, angle, angle + (segments === 1 ? 4.6 : 0.44)); ctx.stroke()
                    }
                }
                RotationAnimator on rotation { from: 0; to: 360; duration: Theme.durLoop; loops: Animation.Infinite; running: ring.visible && !latch.change.queued && Theme.motionEnabled }
                Connections { target: latch; function onChangeChanged() { ring.requestPaint() } }
                Connections { target: Theme; function onAccentChanged() { ring.requestPaint() } }
            }
        }
    }
}
