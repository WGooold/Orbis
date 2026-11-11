import QtQuick
import QtQuick.Controls
import Orbis.Host

Button {
    id: button
    property bool primary: false
    property bool danger: false
    property bool loading: false
    property string symbol: ""
    property string mark: ""
    readonly property bool showsGlyph: mark.length > 0 || symbol.length > 0 || loading
    implicitHeight: Theme.controlHeight
    implicitWidth: Math.max(100, contentItem.implicitWidth + 32)
    font.pixelSize: Theme.body
    font.weight: Font.DemiBold
    hoverEnabled: true
    Accessible.description: loading ? "处理中" : ""
    contentItem: Item {
        // The glyph and the caption share one centered row: a button without an icon keeps
        // no leading slot, and a button with one keeps both on the same optical center.
        implicitWidth: row.implicitWidth
        implicitHeight: Math.max(24, caption.implicitHeight)
        scale: button.down ? 0.94 : 1
        opacity: button.down ? 0.82 : 1
        Behavior on scale { enabled: Theme.motionEnabled; NumberAnimation { duration: button.down ? Theme.durPress : Theme.durRelease; easing.type: Easing.OutCubic } }
        Row {
            id: row
            anchors.centerIn: parent
            spacing: button.showsGlyph ? 8 : 0
            Item {
                id: glyph
                objectName: "actionButtonGlyph"
                width: button.showsGlyph ? 18 : 0; height: 18
                anchors.verticalCenter: parent.verticalCenter
                visible: button.showsGlyph
                AgentMark {
                    anchors.fill: parent; visible: button.mark.length > 0 && !button.loading
                    kind: button.mark
                }
                SymbolIcon {
                    anchors.fill: parent; visible: button.symbol.length > 0 && button.mark.length === 0 && !button.loading
                    name: button.symbol; color: caption.color
                }
                BusyIndicator {
                    anchors.centerIn: parent; width: 18; height: 18
                    visible: button.loading; running: visible && Theme.motionEnabled
                    palette.dark: caption.color
                }
            }
            MotionText {
                id: caption
                objectName: "actionButtonCaption"
                anchors.verticalCenter: parent.verticalCenter
                text: button.text; font: button.font
                horizontalAlignment: Text.AlignHCenter
                color: !button.enabled && !button.loading ? Theme.inkFaint : button.danger ? Theme.danger : button.primary ? Theme.accent : Theme.ink
                Accessible.ignored: true
            }
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
