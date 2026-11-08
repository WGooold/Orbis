import SwiftUI

@main
struct OrbisApp: App {
    @StateObject private var store = OrbisStore()
    @AppStorage("orbis.colorMode") private var colorMode = "system"
    @Environment(\.scenePhase) private var scenePhase
    init() {
        OrbisAppearance.migrate()
        AppLocalization.shared.configure()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-reset-design") {
            UserDefaults.standard.set("mist", forKey: "orbis.appearance")
            UserDefaults.standard.set("light", forKey: "orbis.colorMode")
            UserDefaults.standard.set("codex", forKey: "orbis.lastDraftAgent")
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-screen=") }),
           let defaults = UserDefaults(suiteName: "orbis.preview.language") {
            AppLocalization.shared.configure(defaults: defaults)
            if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--preview-language=") }) {
                let choice = String(argument.dropFirst("--preview-language=".count))
                if choice != "preserve" { AppLocalization.shared.select(.preference(choice)) }
            }
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--preview-screen=") }),
           let screen = argument.split(separator: "=").last {
            _store = StateObject(wrappedValue: makePreviewStore(screen: String(screen)))
        }
        #endif
    }
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-screen=disclosure") {
                DisclosurePerformancePreview()
            } else if ProcessInfo.processInfo.arguments.contains("--preview-screen=reveal") {
                StreamingRevealPreview().environmentObject(store)
            } else if ProcessInfo.processInfo.arguments.contains("--preview-screen=reply-motion") {
                ReplyCardMotionPreview().environmentObject(store)
                    .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--preview-dark") ? .dark : .light)
            } else if ProcessInfo.processInfo.arguments.contains("--preview-screen=feedback") {
                ActionFeedbackPreview()
                    .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--preview-dark") ? .dark : .light)
            } else {
                appContent
            }
            #else
            appContent
            #endif
        }
    }
    private var appContent: some View {
        ContentView().environmentObject(store)
            .preferredColorScheme(preferredScheme)
            .environment(\.locale, AppLocalization.shared.locale)
            .environment(\.layoutDirection, .leftToRight)
            .task { prepareReplyNotifications() }
            .onChange(of: store.pairings.isEmpty) { _, _ in prepareReplyNotifications() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { AppLocalization.shared.refreshSystemLanguage(); prepareReplyNotifications() }
            }
            .onReceive(NotificationCenter.default.publisher(for: NSLocale.currentLocaleDidChangeNotification)) { _ in
                AppLocalization.shared.refreshSystemLanguage()
            }
    }
    private func prepareReplyNotifications() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-screen=") }) { return }
        #endif
        if !store.pairings.isEmpty { ReplyCompletionNotifications.shared.prepare() }
    }
    private var preferredScheme: ColorScheme? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-dark") { return .dark }
        #endif
        return colorMode == "light" ? .light : colorMode == "dark" ? .dark : nil
    }
}
