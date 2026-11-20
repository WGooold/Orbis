import QtQuick
import Orbis.Host

NeuSurface {
    id: root
    // Controls own the surface; search above the owning control for its container.
    readonly property var containerSurface: {
        var item = parent ? parent.parent : null
        while (item) {
            if (item.orbisSurfaceLevel !== undefined) return item
            if (item.background && item.background !== root && item.background.orbisMaterial) return item.background
            item = item.parent
        }
        return null
    }
    readonly property bool orbisMaterial: true
    readonly property int orbisSurfaceLevel: inset ? parentLevel : containerSurface ? Math.min(parentLevel + 1, 2) : 0
    property bool disabled: false
    property bool hovered: false
    // S67: elevation across an overlay uses a tinted cast shadow, not a raised-card halo.
    property bool floatsOverModal: false
    readonly property int parentLevel: containerSurface ? containerSurface.orbisSurfaceLevel : 0
    surface: Theme.surfaceAt(inset ? parentLevel : containerSurface ? Math.min(parentLevel + 1, 2) : hovered ? 1 : 0)
    highlightColor: Theme.highlight
    shadeColor: floatsOverModal ? Theme.scrim : Theme.shade
    focusColor: Theme.accent
    outlineColor: floatsOverModal && !disabled ? Qt.alpha(Theme.hairline, 0.55) : Theme.hairline
    highlightOpacity: Theme.highlightOpacity
    shadeOpacity: floatsOverModal ? (Theme.dark ? 0.48 : 0.24) : Theme.shadeOpacity
    flat: disabled
    outerShadowEnabled: floatsOverModal || containerSurface === null
    outerHighlightEnabled: !floatsOverModal
    outlined: disabled || (floatsOverModal && Theme.dark)
    cornerRadius: Theme.radiusMd
    shadowScale: 0.65
    relief: inset ? -1 : 1
    Behavior on relief { enabled: Theme.motionEnabled; NumberAnimation { duration: root.inset ? Theme.durPress : Theme.durRelease; easing.type: Easing.OutCubic } }
    Behavior on surface { enabled: Theme.motionEnabled; ColorAnimation { duration: Theme.durState } }
}
