import SwiftUI

/// Explicit context for an independent UIHostingConfiguration root. Keep its reader at
/// the native-adapter leaf rather than adding these dependencies to the transcript owner.
/// Preferences, named coordinates and download tap origins need separate native bridges.
@MainActor
struct ChatNativeTranscriptEnvironment {
    struct Values: Equatable {
        let appearance: String
        let colorMode: String
        let accent: Color?
        let surface: OrbisSurfaceContext?
        let colorScheme: ColorScheme
        let reduceMotion: Bool
        let locale: Locale
        let layoutDirection: LayoutDirection
        let dynamicTypeSize: DynamicTypeSize
        let displayScale: CGFloat
        let enabled: Bool
        let keyboardNavigation: Bool
    }

    struct ReconfigurationKey: Equatable {
        let values: Values
        let references: [ObjectIdentifier?]
    }

    let values: Values
    let overlay: OrbisOverlay
    let storeReference: OrbisStore?
    let fileActions: FileTransfers?
    let openFilePreview: ((UUID) -> Void)?
    let downloadFlight: DownloadFlight?
    let sendFlight: MessageSendFlight?
    let visualActivity: ChatVisualActivity?
    let interactions: ChatTranscriptInteractionState?
    let readingInteraction: () -> Void

    /// Reconfigure visible cells when this changes, including appearance-only updates.
    /// Always refresh the adapter's renderer on update: closures have no comparable identity.
    /// A changed reading-action recipient requires an explicit caller generation/reconfigure.
    var reconfigurationKey: ReconfigurationKey {
        ReconfigurationKey(values: values, references: [
            ObjectIdentifier(overlay), storeReference.map { ObjectIdentifier($0) },
            fileActions.map { ObjectIdentifier($0) }, downloadFlight.map { ObjectIdentifier($0) },
            sendFlight.map { ObjectIdentifier($0) }, visualActivity.map { ObjectIdentifier($0) },
            interactions.map { ObjectIdentifier($0) }
        ])
    }

    func applying<Content: View>(_ content: Content) -> some View {
        content
            .environmentObject(overlay)
            .environment(\.orbisStoreReference, storeReference)
            .environment(\.orbisFileActions, fileActions)
            .environment(\.openChatFilePreview, openFilePreview)
            .environment(\.downloadFlight, downloadFlight)
            .environment(\.messageSendFlight, sendFlight)
            .environment(\.chatVisualActivity, visualActivity)
            .environment(\.chatTranscriptInteractionState, interactions)
            .environment(\.chatReadingInteraction, readingInteraction)
            .environment(\.orbisAppearance, values.appearance)
            .environment(\.orbisColorMode, values.colorMode)
            .environment(\.orbisAccent, values.accent)
            .environment(\.orbisSurface, values.surface)
            .environment(\.orbisKeyboardNavigation, values.keyboardNavigation)
            .environment(\.colorScheme, values.colorScheme)
            .environment(\.locale, values.locale)
            .environment(\.layoutDirection, values.layoutDirection)
            .environment(\.dynamicTypeSize, values.dynamicTypeSize)
            .environment(\.displayScale, values.displayScale)
            .environment(\.isEnabled, values.enabled)
            .tint(values.accent)
        // accessibilityReduceMotion is public get-only. Each root reads the same system
        // setting and process preview flag; the captured value above also invalidates cells.
        // Visual clocks observe the stable chatVisualActivity reference at their leaf.
        // Visibility and scene changes must not invalidate hosted row measurements.
    }
}

@MainActor
struct ChatNativeTranscriptEnvironmentReader<Content: View>: View {
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.orbisStoreReference) private var storeReference
    @Environment(\.orbisFileActions) private var fileActions
    @Environment(\.openChatFilePreview) private var openFilePreview
    @Environment(\.downloadFlight) private var downloadFlight
    @Environment(\.messageSendFlight) private var sendFlight
    @Environment(\.chatVisualActivity) private var visualActivity
    @Environment(\.chatTranscriptInteractionState) private var interactions
    @Environment(\.chatReadingInteraction) private var readingInteraction
    @Environment(\.orbisAppearance) private var appearance
    @Environment(\.orbisColorMode) private var colorMode
    @Environment(\.orbisAccent) private var accent
    @Environment(\.orbisSurface) private var surface
    @Environment(\.orbisKeyboardNavigation) private var keyboardNavigation
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale
    @Environment(\.isEnabled) private var enabled
    private let content: (ChatNativeTranscriptEnvironment) -> Content

    init(@ViewBuilder content: @escaping (ChatNativeTranscriptEnvironment) -> Content) {
        self.content = content
    }

    var body: some View {
        content(ChatNativeTranscriptEnvironment(
            values: .init(appearance: appearance, colorMode: colorMode, accent: accent,
                          surface: surface, colorScheme: colorScheme,
                          reduceMotion: reduceMotion, locale: locale,
                          layoutDirection: layoutDirection, dynamicTypeSize: dynamicTypeSize,
                          displayScale: displayScale, enabled: enabled,
                          keyboardNavigation: keyboardNavigation),
            overlay: overlay, storeReference: storeReference, fileActions: fileActions, openFilePreview: openFilePreview,
            downloadFlight: downloadFlight, sendFlight: sendFlight,
            visualActivity: visualActivity, interactions: interactions, readingInteraction: readingInteraction))
    }
}
