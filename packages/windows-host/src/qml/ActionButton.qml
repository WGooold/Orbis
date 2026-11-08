import QtQuick
import QtQuick.Controls
import Orbis.Host

Button {
    id: button
    property bool primary: false
    property bool danger: false
    property bool loading: false
    property string symbol: ""
    implicitHeight: Theme.controlHeight
    implicitWidth: Math.max(100, contentItem.implicitWidth + 32)
    font.pixelSize: Theme.body
    font.weight: Font.DemiBold
    hoverEnabled: true
    Accessible.description: loading ? "处理中" : ""
    contentItem: Item {
        implicitWidth: caption.implicitWidth + 26
        implicitHeight: Math.max(24, caption.implicitHeight)
        scale: button.down ? 0.94 : 1
        opacity: button.down ? 0.82 : 1
        Behavior on scale { enabled: Theme.motionEnabled; NumberAnimation { duration: button.down ? Theme.durPress : Theme.durRelease; easing.type: Easing.OutCubic } }
        SymbolIcon {
            id: symbol
            name: button.symbol; width: 18; height: 18
            anchors.verticalCenter: parent.verticalCenter
            visible: !!button.symbol && !button.loading
            color: caption.color
        }
        BusyIndicator {
            anchors.centerIn: symbol; width: 18; height: 18
            visible: button.loading; running: visible && Theme.motionEnabled
            palette.dark: caption.color
        }
        MotionText {
            id: caption
            anchors.verticalCenter: parent.verticalCenter
            x: 26
            width: parent.width - x; height: implicitHeight
            text: button.text; font: button.font
            horizontalAlignment: Text.AlignHCenter
            color: !button.enabled && !button.loading ? Theme.inkFaint : button.danger ? Theme.danger : button.primary ? Theme.accent : Theme.ink
            Accessible.ignored: true
        }
    }
    background: Surface {
        anchors.fill: parent; anchors.margins: -12; margin: 12
        inset: button.down
        focused: button.activeFocus
        disabled: !button.enabled && !button.loading
        hovered: button.hovered
    }
}
