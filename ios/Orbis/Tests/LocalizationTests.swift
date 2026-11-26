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
                                ("连接你的电脑", "Connect your computer"), ("下载", "Downloads"),
                                ("隐私", "Privacy"), ("设备使用统计", "Device usage sharing")] {
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

    @Test func claudeApprovalChoicesDistinguishOneCallFromFutureEdits() {
        // CLAUDE-PERMISSION-01: the two allow choices must stay distinct in either language.
        let once = "允许一次", acceptEdits = "允许并自动接受本会话的后续编辑"
        #expect(L10n.hostText(once, language: .english) == "Allow once")
        #expect(L10n.hostText(acceptEdits, language: .english) == "Allow and accept future edits in this session")
        #expect(L10n.hostText(acceptEdits, language: .chinese) == acceptEdits)
        #expect(L10n.hostText("拒绝", language: .english) == "Deny")
    }

    @Test func hostUiCopyIsLocalizedWithoutInterpretingPermissionsOrDynamicValues() {
        // SC85: permission recovery uses the same localized reason on controls and failed sends.
        #expect(L10n.hostText("权限设置尚未确认，请稍后重试", language: .english) == "Permissions are unconfirmed. Try again shortly.")
        #expect(L10n.hostText("权限设置正在保存，请稍后重试", language: .english) == "Permission settings are being saved. Try again shortly.")
        #expect(L10n.hostSummary("工作区可写 · 按需询问", language: .english) == "Workspace write, Ask when needed")
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


@Suite
struct OpenCodeAvailabilityTests {
    // HOST-AGENT-START-01: launchability enables a draft without implying a live connection.
    @Test func coldOpenCodeUsesTheExistingLaunchableBit() {
        let cold = OpenCodeAvailability(backends: .array([.object([
            "kind": .string("opencode"), "ready": .bool(false), "launchable": .bool(true), "reason": .string("service_not_found"),
        ])]))
        #expect(cold?.canStart == true)
        #expect(cold?.ready == false)
        #expect(OpenCodeAvailability.draftNotice(selectedAgent: "opencode", availability: cold) == nil)
    }

    @Test func backendAvailabilityIsAdvertisedAndNotInferred() {
        #expect(OpenCodeAvailability(backends: .array([.object(["kind": .string("pi"), "ready": .bool(true)])])) == nil)
        #expect(OpenCodeAvailability(backends: .array([.object(["kind": .string("opencode"), "ready": .string("true")])])) == nil)
        let ready = OpenCodeAvailability(backends: .array([.object(["kind": .string("opencode"), "ready": .bool(true)])]))
        #expect(ready?.ready == true)
        #expect(ready?.message == nil)
        func unavailable(_ reason: String) -> OpenCodeAvailability? {
            OpenCodeAvailability(backends: .array([.object(["kind": .string("opencode"), "ready": .bool(false), "reason": .string(reason)])]))
        }
        let missing = unavailable("service_not_found"), incompatible = unavailable("unsupported_version")
        #expect(missing?.ready == false)
        #expect(incompatible?.ready == false)
        #expect(missing?.message != nil)
        #expect(incompatible?.message != nil)
        #expect(missing?.message != incompatible?.message)
        // Only surface OpenCode unavailability when OpenCode itself is the selected draft agent.
        #expect(OpenCodeAvailability.draftNotice(selectedAgent: "codex", availability: missing) == nil)
        #expect(OpenCodeAvailability.draftNotice(selectedAgent: "claude", availability: incompatible) == nil)
        #expect(OpenCodeAvailability.draftNotice(selectedAgent: "opencode", availability: missing) == missing?.message)
        #expect(OpenCodeAvailability.draftNotice(selectedAgent: "opencode", availability: ready) == nil)
    }

    @Test func draftAgentReconciliationPrefersLaunchableWhileKeepingInspectedOpenCode() {
        let family: (String) -> String = { $0 == "codexDesktop" ? "codex" : $0 == "dshDesktop" ? "dsh" : $0 }
        let choices = ["codex", "claude", "dsh", "pi", "opencode"]
        // Reopening with a previously saved OpenCode draft falls back to an available agent when OpenCode is down.
        let initial = reconcileDraftAgent(
            current: "opencode",
            allowed: ["codex", "pi"],
            choices: choices,
            showsOpenCode: true,
            allowUnavailableOpenCode: false,
            preferLaunchable: true,
            familyOf: family
        )
        #expect(initial == DraftAgentReconciliation(agent: "codex", allowUnavailableOpenCode: false, shouldPersist: true))
        // Tapping unavailable OpenCode keeps it selected across unrelated capability updates while OpenCode stays shown.
        let inspected = reconcileDraftAgent(
            current: "opencode",
            allowed: ["codex", "pi", "dsh"],
            choices: choices,
            showsOpenCode: true,
            allowUnavailableOpenCode: true,
            preferLaunchable: false,
            familyOf: family
        )
        #expect(inspected == DraftAgentReconciliation(agent: "opencode", allowUnavailableOpenCode: true, shouldPersist: false))
        // Disabling OpenCode on the Host falls back to an available agent.
        let disabled = reconcileDraftAgent(
            current: "opencode",
            allowed: ["codex", "pi"],
            choices: ["codex", "claude", "dsh", "pi"],
            showsOpenCode: false,
            allowUnavailableOpenCode: true,
            preferLaunchable: false,
            familyOf: family
        )
        #expect(disabled == DraftAgentReconciliation(agent: "codex", allowUnavailableOpenCode: false, shouldPersist: true))
        // When only OpenCode is enabled and unavailable, select OpenCode so its reason is visible.
        let onlyOpenCode = reconcileDraftAgent(
            current: "codex",
            allowed: [],
            choices: ["opencode"],
            showsOpenCode: true,
            allowUnavailableOpenCode: false,
            preferLaunchable: true,
            familyOf: family
        )
        #expect(onlyOpenCode == DraftAgentReconciliation(agent: "opencode", allowUnavailableOpenCode: true, shouldPersist: false))
    }
}
