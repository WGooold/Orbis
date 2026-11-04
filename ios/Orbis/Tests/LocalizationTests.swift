import Foundation
import Testing
@testable import OrbisCore

@Suite("App language")
struct LocalizationTests {
    @Test func resolvesPreferredLanguagesAndUnsupportedFallback() {
        for tag in ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH_hans_CN"] {
            #expect(AppLanguage.system.resolved(preferredLanguages: [tag]) == .chinese)
        }
        #expect(AppLanguage.system.resolved(preferredLanguages: ["en-GB", "zh-CN"]) == .english)
        #expect(AppLanguage.system.resolved(preferredLanguages: ["fr-FR", "zh-TW", "en-US"]) == .chinese)
        #expect(AppLanguage.system.resolved(preferredLanguages: ["ar", "ja"]) == .english)
        #expect(AppLanguage.system.resolved(preferredLanguages: []) == .english)
    }

    @Test func explicitChoiceOverridesDeviceAndInvalidChoiceFollowsSystem() {
        #expect(AppLanguage.chinese.resolved(preferredLanguages: ["en"]) == .chinese)
        #expect(AppLanguage.english.resolved(preferredLanguages: ["zh"]) == .english)
        #expect(AppLanguage.preference(nil) == .system)
        #expect(AppLanguage.preference("unsupported") == .system)
    }

    @Test func selectionPersistsAndSystemChangesOnlyAffectSystemMode() throws {
        let name = "orbis-language-test-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var deviceLanguages = ["en-US"]
        let first = AppLocalization()
        first.configure(defaults: defaults, preferredLanguages: { deviceLanguages })
        #expect(first.preference == .system && first.language == .english)
        first.select(.chinese)
        let restarted = AppLocalization()
        restarted.configure(defaults: defaults, preferredLanguages: { deviceLanguages })
        #expect(restarted.preference == .chinese && restarted.language == .chinese)
        deviceLanguages = ["fr"]
        restarted.refreshSystemLanguage()
        #expect(restarted.language == .chinese)
        restarted.select(.system)
        #expect(restarted.language == .english)
        deviceLanguages = ["zh-Hant"]
        restarted.refreshSystemLanguage()
        #expect(restarted.language == .chinese)
    }

    @Test func interpolationPreservesOpaqueTextAndDoesNotReparseArguments() {
        let literal = "设置 {1} $HOME /中文/code.swift 100% \\n"
        #expect(L10n.format("最近提问，{0}", arguments: [literal], language: .english) == "Latest question, " + literal)
        #expect(L10n.format("{0} 不是合法的 base64url", arguments: [literal], language: .chinese) == literal + " 不是合法的 base64url")
        #expect(L10n.format("source message / code", language: .english) == "source message / code")
    }

    @Test func formattingSupportsReorderingAndMalformedPlaceholdersSafely() {
        #expect(L10n.format("{0} / {1}", arguments: ["{1}", "100%"], language: .english) == "{1} / 100%")
        #expect(L10n.format("{9} {99999999999999999999999}", arguments: ["a"], language: .english) == "{9} {99999999999999999999999}")
        #expect(L10n.format("第 {0} / {1} 题，{2}", arguments: ["1", "3", "Your text"], language: .english) == "Question 1 / 3, Your text")
    }

    @Test func principalSurfacesHaveEnglishCopy() {
        for (key, expected) in [("设置", "Settings"), ("语言", "Language"), ("跟随系统", "Follow system"),
                                ("发送消息", "Send message"), ("历史与分支", "History and branches"),
                                ("连接你的电脑", "Connect your computer"), ("下载", "Downloads")] {
            #expect(L10n.format(key, language: .english) == expected)
            #expect(L10n.format(key, language: .chinese) == key)
        }
    }

    @Test func englishCountsUseSingularAndPlural() {
        #expect(L10n.format("{0} 个文件已更改", arguments: ["1"], language: .english) == "1 file changed")
        #expect(L10n.format("{0} 个文件已更改", arguments: ["0"], language: .english) == "0 files changed")
        #expect(L10n.format("{0} 个文件已更改", arguments: ["2"], language: .english) == "2 files changed")
        #expect(L10n.format("{0} 个文件已更改", arguments: ["1"], language: .chinese) == "1 个文件已更改")
    }

    @Test func knownFailuresRemainRecognizableAfterALanguageChange() {
        let source = "关闭会话未确认：会话仍在运行。"
        #expect(L10n.matches(source, source: source))
        #expect(L10n.matches("Session close unconfirmed: the session is still running.", source: source))
        #expect(!L10n.matches("Original backend detail", source: source))
    }

    @Test func hostUiCopyIsLocalizedWithoutInterpretingPermissionsOrDynamicValues() {
        #expect(L10n.hostSummary("工作区可写 · 按需询问", language: .english) == "Workspace write · Ask when needed")
        #expect(L10n.hostText("Select the model for this Codex session", language: .chinese) == "选择此 Codex 会话的模型")
        let path = "/工作区可写/设置 {1}/file.swift 100% 🧪"
        #expect(L10n.hostText("原生报告的可读目录：\(path)。", language: .english) == "Native readable directories: \(path).")
        #expect(L10n.hostText("Switch model (current: \(path))", language: .chinese) == "切换模型（当前 \(path)）")
        #expect(L10n.hostText("网络：允许联网。\nVendor-only detail", language: .english) == "Network: access allowed.\nVendor-only detail")
        // This API is a finite Host UI allowlist, not a general translation of received text.
        #expect(L10n.hostText("设置", language: .english) == "设置")
        #expect(L10n.hostText("Vendor custom 工作区可写 label", language: .english) == "Vendor custom 工作区可写 label")
    }
}
