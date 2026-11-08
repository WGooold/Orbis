pragma Singleton
import QtQuick
import QtCore

QtObject {
    id: theme
    // The same four semantic palettes as the approved design reference.
    property var preferences: Settings {
        category: "Appearance"
        location: typeof orbisAppearanceSettings === "undefined" ? "" : orbisAppearanceSettings
        property string material: "mist"
        property string mode: "system"
    }
    property var systemPalette: SystemPalette { colorGroup: SystemPalette.Active }
    readonly property bool dark: preferences.mode === "dark" || (preferences.mode === "system" && systemPalette.window.hslLightness < 0.5)
    readonly property bool sage: preferences.material === "sage"
    readonly property string themeId: (sage ? "sage-" : "") + (dark ? "dark" : "light")
    readonly property bool motionEnabled: typeof orbisMotionEnabled === "undefined" || orbisMotionEnabled
    function value(light, darkValue, sageLight, sageDark) { return sage ? (dark ? sageDark : sageLight) : (dark ? darkValue : light) }
    readonly property var palettes: {"surface-base":["#e6ebf4","#23262e","#e0e7df","#33393d"],"surface-lift":["#edf1f8","#292d36","#e8eee5","#3a4246"],"surface-top":["#f3f6fb","#2f333d","#f0f5ed","#424b50"],"highlight":["#ffffff","#343946","#f8fbf5","#4a555a"],"shade":["#a6b2c6","#0a0c11","#b2c0b0","#1c2427"],"hairline":["#c9d1de","#3a4150","#c7d1c5","#4a5653"],"scrim":["#2a3344","#05070a","#203626","#0b1214"],"ink":["#232a36","#dde1e9","#2f4235","#eff3f0"],"ink-muted":["#4a5364","#b8c0ce","#4f6153","#bac7c2"],"ink-faint":["#737d90","#858d9c","#6e7f6f","#8e9c97"],"accent":["#2f5287","#afc6e6","#41603f","#a9ddc1"],"accent-soft":["#d0d9e7","#343944","#d3dcd2","#414d4d"],"on-accent":["#ffffff","#16233a","#ffffff","#173322"],"success":["#1a6a4d","#84d6b3","#1a6a4d","#8fddb8"],"warning":["#845000","#f2c26b","#845000","#f2c26b"],"danger":["#ad241c","#ffb4ab","#ad241c","#ffb4ab"],"agent-pi":["#8c3870","#f0a9d3","#8c3870","#f0a9d3"],"agent-codex":["#00655d","#77d6c7","#00655d","#77d6c7"],"agent-deepseek":["#3550cf","#a9bbff","#3550cf","#a9bbff"],"agent-claude":["#9a4521","#f0b48c","#9a4521","#f0b48c"]}
    function colorFor(role, useSage, useDark) { return palettes[role][(useSage ? 2 : 0) + (useDark ? 1 : 0)] }
    function surfaceAt(level) { return level <= 0 ? surfaceBase : level === 1 ? surfaceLift : surfaceTop }
    readonly property color surfaceBase: value("#e6ebf4", "#23262e", "#e0e7df", "#33393d")
    readonly property color surfaceLift: value("#edf1f8", "#292d36", "#e8eee5", "#3a4246")
    readonly property color surfaceTop: value("#f3f6fb", "#2f333d", "#f0f5ed", "#424b50")
    readonly property color highlight: value("#ffffff", "#343946", "#f8fbf5", "#4a555a")
    readonly property color shade: value("#a6b2c6", "#0a0c11", "#b2c0b0", "#1c2427")
    readonly property color hairline: value("#c9d1de", "#3a4150", "#c7d1c5", "#4a5653")
    readonly property color scrim: value("#2a3344", "#05070a", "#203626", "#0b1214")
    readonly property color ink: value("#232a36", "#dde1e9", "#2f4235", "#eff3f0")
    readonly property color inkMuted: value("#4a5364", "#b8c0ce", "#4f6153", "#bac7c2")
    readonly property color inkFaint: value("#737d90", "#858d9c", "#6e7f6f", "#8e9c97")
    readonly property color accent: value("#2f5287", "#afc6e6", "#41603f", "#a9ddc1")
    readonly property color accentSoft: value("#d0d9e7", "#343944", "#d3dcd2", "#414d4d")
    readonly property color success: dark ? (sage ? "#8fddb8" : "#84d6b3") : "#1a6a4d"
    readonly property color warning: dark ? "#f2c26b" : "#845000"
    readonly property color danger: dark ? "#ffb4ab" : "#ad241c"
    readonly property color agentPi: dark ? "#f0a9d3" : "#8c3870"
    readonly property color agentCodex: dark ? "#77d6c7" : "#00655d"
    readonly property color agentDeepseek: dark ? "#a9bbff" : "#3550cf"
    readonly property color agentClaude: dark ? "#f0b48c" : "#9a4521"
    function agent(kind) { return ({pi:agentPi,codex:agentCodex,dsh:agentDeepseek,claude:agentClaude})[kind] || ink }
    readonly property real highlightOpacity: dark ? (sage ? 0.7 : 0.8) : (sage ? 0.8 : 0.9)
    readonly property real shadeOpacity: dark ? 0.7 : (sage ? 0.65 : 0.55)
    readonly property int display: 28
    readonly property int title: 20
    readonly property int body: 15
    readonly property int label: 13
    readonly property int caption: 12
    readonly property int radiusXs: 8
    readonly property int radiusSm: 12
    readonly property int radiusMd: 16
    readonly property int radiusLg: 24
    readonly property int radiusXl: 32
    readonly property int touchTarget: 48
    readonly property int fieldHeight: 56
    readonly property int controlHeight: 48
    readonly property int iconMd: 22
    readonly property int iconSm: 18
    readonly property int iconXs: 16
    readonly property int hostSidebar: 232
    readonly property int contentWidth: 880
    readonly property int durPress: 80
    readonly property int durRelease: 160
    readonly property int durState: 160
    readonly property int durPanel: 220
    readonly property int durSelection: 260
    readonly property int durCollapse: 260
    readonly property int durExit: 160
    readonly property int durPage: 320
    readonly property int durLoop: 1100
    readonly property int durFadeOut: 90
    readonly property int durFadeIn: 210
}
