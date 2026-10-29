import SwiftUI

@main
struct OrbisApp: App {
    @StateObject private var store = OrbisStore()
    init() {
        #if DEBUG
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
            #if DEBUG
            .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--preview-dark") ? .dark : nil)
            #endif
    }
}
