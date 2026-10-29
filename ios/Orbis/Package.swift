// swift-tools-version: 5.9
import PackageDescription

// The same sources are compiled into the iOS app. This package lets protocol
// and state regression tests run with macOS Command Line Tools, without an iOS SDK.
let package = Package(
    name: "OrbisCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    targets: [
        .target(name: "OrbisCore", path: "Orbis", exclude: [
            "OrbisApp.swift", "ContentView.swift", "PairingScannerView.swift", "OrbisDesign.swift",
            "PreviewSupport.swift", "ToolDetailView.swift", "DownloadView.swift", "InteractionView.swift", "SessionViews.swift", "ChatView.swift", "StatusViews.swift", "HistoryBranchView.swift", "Info.plist", "Assets.xcassets"
        ], linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "OrbisCoreTests", dependencies: ["OrbisCore"], path: "Tests", resources: [.copy("Fixtures")])
    ]
)
