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
    readonly property int parentLevel: containerSurface ? containerSurface.orbisSurfaceLevel : 0
    surface: Theme.surfaceAt(inset ? parentLevel : containerSurface ? Math.min(parentLevel + 1, 2) : hovered ? 1 : 0)
    highlightColor: Theme.highlight
    shadeColor: Theme.shade
    focusColor: Theme.accent
    outlineColor: Theme.hairline
    highlightOpacity: Theme.highlightOpacity
    shadeOpacity: Theme.shadeOpacity
    flat: disabled
    outerShadowEnabled: containerSurface === null
    outlined: disabled
    cornerRadius: Theme.radiusMd
    shadowScale: 0.65
    relief: inset ? -1 : 1
    Behavior on relief { enabled: Theme.motionEnabled; NumberAnimation { duration: root.inset ? Theme.durPress : Theme.durRelease; easing.type: Easing.OutCubic } }
    Behavior on surface { enabled: Theme.motionEnabled; ColorAnimation { duration: Theme.durState } }
}
