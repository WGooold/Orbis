import SwiftUI

struct VoiceCleanupSettings: View {
    let onClose: () -> Void
    let onSaved: (Bool) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var advancedOpen = false
    @State private var enabled = false
    @State private var endpoint = ""
    @State private var model = ""
    @State private var key = ""
    @State private var custom = false
    @State private var format = VoiceCleanupJSONFormat.example
    @State private var feedback: String?
    @State private var example: String?
    @State private var testTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("语音清理"), closes: true, back: onClose) {
                OrbisInfoButton(title: L10n.tr("语音清理"),
                    message: L10n.tr("默认在手机上去除明显口癖。开启 API 后只发送本次转写，Key 仅存此设备。关闭并保存会删除 API 配置和 Key。"),
                    identifier: "voice-cleanup-info")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Toggle(L10n.tr("使用自定义模型 API"), isOn: $enabled)
                        .accessibilityIdentifier("voice-cleanup-api-toggle")
                    if enabled { apiFields }
                }.disabled(testTask != nil).padding(.top, 12)
                if testTask != nil { ProgressView().padding(.vertical, 8) }
                if let feedback {
                    Text(L10n.tr(feedback)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                }
                if enabled, let example {
                    VStack(alignment: .leading, spacing: 4) {
                        hint("测试返回")
                        Text(verbatim: example).textSelection(.enabled)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                }
            }.scrollDismissesKeyboard(.interactively)
            Button { apply(test: false) } label: {
                Text(L10n.tr("保存")).frame(maxWidth: .infinity, minHeight: 36)
            }.buttonStyle(.borderedProminent).disabled(testTask != nil)
                .padding(.top, 8).accessibilityIdentifier("voice-cleanup-save")
        }.padding(16)
            .task {
                do {
                    if let config = try SecureStore.shared.voiceCleanupAPIConfig() {
                        enabled = true
                        endpoint = config.endpoint
                        model = config.model
                        key = config.key
                        custom = config.custom != nil
                        format = config.custom ?? .example
                    }
                } catch { feedback = "无法读取语音清理配置" }
            }
            .onChange(of: enabled) { _, _ in feedback = nil; example = nil }
            .onDisappear { testTask?.cancel(); testTask = nil }
    }

    private var apiFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            field("API 请求地址", text: $endpoint, prompt: "https://example.com/v1/chat/completions")
                .keyboardType(.URL).accessibilityIdentifier("voice-cleanup-endpoint")
            field("模型名称", text: $model)
            VStack(alignment: .leading, spacing: 5) {
                hint("API Key（可选）")
                SecureField(L10n.tr("API Key（可选）"), text: $key, prompt: Text(verbatim: ""))
                    .textContentType(.password).textFieldStyle(.roundedBorder).accessibilityIdentifier("voice-cleanup-key")
            }
            Divider()
            DisclosureGroup(isExpanded: $advancedOpen) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Toggle(L10n.tr("自定义 JSON 请求"), isOn: $custom)
                        OrbisInfoButton(title: L10n.tr("自定义 JSON 请求"),
                            message: L10n.tr("请求头用 {{key}}；请求体可用 {{model}}、{{instruction}} 和 {{transcript}}。返回路径示例：/content/0/text。"),
                            identifier: "voice-cleanup-format-info")
                    }
                    if custom {
                        field("请求头 JSON", text: $format.headers, multiline: true)
                        field("请求体 JSON", text: $format.body, multiline: true)
                        field("文本返回路径", text: $format.responsePath, prompt: "/content/0/text")
                    }
                }.padding(.top, 12)
            } label: {
                HStack {
                    Text(L10n.tr("高级设置"))
                    Spacer()
                    Text(verbatim: custom ? "JSON" : "Chat Completions")
                        .font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                }.frame(minHeight: 44)
            }.accessibilityIdentifier("voice-cleanup-advanced")
                .onChange(of: custom) { _, _ in feedback = nil; example = nil }
            Button { apply(test: true) } label: {
                Text(L10n.tr("用示例文字测试")).frame(maxWidth: .infinity, minHeight: 32)
            }.buttonStyle(.bordered)
        }
    }

    private func hint(_ title: String) -> some View {
        Text(L10n.tr(title)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
    }

    private func field(_ title: String, text: Binding<String>, prompt: String = "", multiline: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            hint(title)
            TextField(L10n.tr(title), text: text, prompt: Text(verbatim: prompt),
                      axis: multiline ? .vertical : .horizontal)
                .lineLimit(multiline ? 3...8 : 1...1)
                .textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }

    private func apply(test: Bool) {
        feedback = nil
        example = nil
        let config = enabled ? VoiceCleanupAPIConfig(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
            model: model.trimmingCharacters(in: .whitespacesAndNewlines), key: key.trimmingCharacters(in: .whitespacesAndNewlines),
            custom: custom ? format : nil) : nil
        if let config, !VoiceTextCleanupAPI.isValid(config) {
            feedback = "请检查 HTTPS 地址、模型名和请求格式"
            return
        }
        if test, let config {
            testTask = Task { @MainActor in
                do {
                    let result = try await VoiceTextCleanupAPI.request(config, text: VoiceTextCleanupAPI.exampleTranscript)
                    guard !Task.isCancelled else { return }
                    example = result
                } catch {
                    guard !Task.isCancelled else { return }
                    feedback = "测试失败，请检查地址、Key 和返回格式"
                }
                testTask = nil
            }
        } else {
            do {
                try SecureStore.shared.saveVoiceCleanupAPIConfig(config)
                onSaved(config != nil)
            } catch { feedback = "无法保存语音清理配置" }
        }
    }
}
