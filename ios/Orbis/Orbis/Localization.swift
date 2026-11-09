import Foundation
import Observation

enum AppLanguage: String, CaseIterable {
    case system, chinese = "zh-Hans", english = "en"

    static func preference(_ value: String?) -> AppLanguage { value.flatMap(Self.init(rawValue:)) ?? .system }

    func resolved(preferredLanguages: [String]) -> AppLanguage {
        guard self == .system else { return self }
        for identifier in preferredLanguages {
            switch identifier.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-").first {
            case "zh": return .chinese
            case "en": return .english
            default: continue
            }
        }
        return .english
    }
}

/// Application-owned text only. Dynamic content is never looked up in the catalog.
/// Observation tracks reads in SwiftUI without replacing any view or session identity.
@Observable final class AppLocalization {
    static let shared = AppLocalization()
    static let preferenceKey = "orbis.language"
    private(set) var preference: AppLanguage = .system
    // The core is deterministic until the app supplies its device preferences at startup.
    private(set) var language: AppLanguage = .chinese
    @ObservationIgnored private var defaults: UserDefaults?
    @ObservationIgnored private var preferredLanguages: () -> [String] = { Locale.preferredLanguages }

    var locale: Locale { Locale(identifier: language == .chinese ? "zh_Hans" : "en") }

    func configure(defaults: UserDefaults = .standard, preferredLanguages: @escaping () -> [String] = { Locale.preferredLanguages }) {
        self.defaults = defaults
        self.preferredLanguages = preferredLanguages
        preference = .preference(defaults.string(forKey: Self.preferenceKey))
        refreshSystemLanguage()
    }

    func select(_ choice: AppLanguage) {
        preference = choice
        defaults?.set(choice.rawValue, forKey: Self.preferenceKey)
        refreshSystemLanguage()
    }

    func refreshSystemLanguage() { language = preference.resolved(preferredLanguages: preferredLanguages()) }
}

enum L10n {
    private static let placeholder = try! NSRegularExpression(pattern: "\\{([0-9]+)\\}")
    private static let hostSourcesByEnglish = Dictionary(LocalizationCatalog.hostExact.sorted().compactMap { source in
        LocalizationCatalog.english[source].map { ($0, source) }
    }, uniquingKeysWith: { _, last in last })
    private static let hostPatterns: [(source: String, prefix: String, suffix: String)] = LocalizationCatalog.hostTemplates.flatMap { source in
        [source, LocalizationCatalog.english[source] ?? source].map { template in
            let parts = template.components(separatedBy: "{0}")
            return (source, parts[0], parts[1])
        }
    }
    static var locale: Locale { AppLocalization.shared.locale }
    // Only for Host-owned permission UI and built-in command descriptions. Never message content.
    static func hostText(_ value: String, language: AppLanguage = AppLocalization.shared.language) -> String {
        func line(_ value: String) -> String? {
            if LocalizationCatalog.hostExact.contains(value) { return format(value, language: language) }
            if let source = hostSourcesByEnglish[value] {
                return format(source, language: language)
            }
            for pattern in hostPatterns {
                if value.hasPrefix(pattern.prefix) && value.hasSuffix(pattern.suffix) && value.count >= pattern.prefix.count + pattern.suffix.count {
                    let argument = String(value.dropFirst(pattern.prefix.count).dropLast(pattern.suffix.count))
                    return format(pattern.source, arguments: [argument], language: language)
                }
            }
            return nil
        }
        if let translated = line(value) { return translated }
        return value.components(separatedBy: "\n").map { line($0) ?? $0 }.joined(separator: "\n")
    }
    static func hostSummary(_ value: String, language: AppLanguage = AppLocalization.shared.language) -> String {
        value.components(separatedBy: " · ").map { hostText($0, language: language) }
            .joined(separator: language == .english ? ", " : "，")
    }
    static func matches(_ value: String, source: String) -> Bool {
        value == source || value == LocalizationCatalog.english[source]
    }
    static func tr(_ source: String, _ arguments: Any...) -> String {
        format(source, arguments: arguments.map { String(describing: $0) }, language: AppLocalization.shared.language)
    }

    static func format(_ source: String, arguments: [String] = [], language: AppLanguage) -> String {
        let template: String
        if language == .english {
            template = arguments.first.flatMap(Double.init) == 1
                ? LocalizationCatalog.singular[source] ?? LocalizationCatalog.english[source] ?? source
                : LocalizationCatalog.english[source] ?? source
        } else { template = source }
        guard !arguments.isEmpty else { return template }
        // Replace in one pass: an argument containing {1}, %, code or a path stays literal.
        let input = template as NSString
        var output = ""
        var offset = 0
        for match in placeholder.matches(in: template, range: NSRange(location: 0, length: input.length)) {
            output += input.substring(with: NSRange(location: offset, length: match.range.location - offset))
            if let index = Int(input.substring(with: match.range(at: 1))), arguments.indices.contains(index) {
                output += arguments[index]
            } else { output += input.substring(with: match.range) }
            offset = match.range.location + match.range.length
        }
        return output + input.substring(from: offset)
    }
}
