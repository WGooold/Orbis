import Foundation
import Testing

/// PERF-12: SwiftUI re-evaluates every `@AppStorage` property on any `UserDefaults.standard` write,
/// whatever its key, so one in a mounted view re-renders it on every draft keystroke or catalog save.
/// Display preferences reach views through `OrbisDisplaySettings` and the environment instead; the
/// only remaining use belongs to the new-session card, mounted only while it is open.
@Suite("Display preferences stay off @AppStorage")
struct DisplayPreferenceTests {
    @Test func appStorageIsLimitedToTheDraftCardAgent() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Orbis")
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        #expect(files.count > 20)
        var uses: [String] = []
        for file in files {
            for (index, line) in try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n").enumerated() {
                let code = line.trimmingCharacters(in: .whitespaces)
                guard code.contains("@AppStorage("), !code.hasPrefix("//") else { continue }
                if !code.contains("@AppStorage(\"orbis.lastDraftAgent\")") { uses.append("\(file.lastPathComponent):\(index + 1)") }
            }
        }
        #expect(uses.isEmpty, "Read display preferences from \\.orbisAppearance / \\.orbisColorMode: \(uses)")
    }
}
