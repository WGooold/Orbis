import QtQuick
import QtQuick.Controls
import Orbis.Host

Button {
    id: button
    property bool primary: false
    property bool danger: false
    implicitHeight: 42
    implicitWidth: Math.max(100, contentItem.implicitWidth + 36)
    font.pixelSize: 14
    font.weight: primary ? Font.DemiBold : Font.Normal
    hoverEnabled: true
    contentItem: Text {
        text: button.text
        font: button.font
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        color: !button.enabled ? "#8995a9" : button.primary ? "#2459D3" : button.danger ? "#a63838" : "#253651"
    }
    background: NeuSurface {
        anchors.fill: parent; anchors.margins: -12; margin: 12
        cornerRadius: 10
        inset: button.down || !button.enabled
        focused: button.activeFocus
        opacity: button.enabled ? 1 : 0.6
    }
}
