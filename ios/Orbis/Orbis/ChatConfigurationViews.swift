import SwiftUI

struct PermissionsView: View {
    @EnvironmentObject private var store: OrbisStore
    @OrbisDismiss private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    private var actions: ChatSessionActions { ChatSessionActions(store: store, target: target, preservingRuntime: runtime) }
    let target: ChatActionContext
    let runtime: RuntimeSummary
    @State private var proposedSetting: String?
    @State private var proposedValue: String?
    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("当前会话权限"), closes: true, back: { dismiss() }) {
                if let permissions = store.selectedRuntime?.permissionManagement {
                    OrbisInfoButton(title: L10n.tr("当前会话权限"), message: L10n.hostText(permissions.details), identifier: "permission-info")
                }
            }
            if let permissions = store.selectedRuntime?.permissionManagement {
                Text(L10n.hostSummary(permissions.summary)).font(.orbisLabel()).foregroundStyle(p.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
                OrbisPermissionChoices(settings: permissions.settings, values: proposedValues(permissions),
                    currentValues: Dictionary(uniqueKeysWithValues: permissions.settings.compactMap { item in item.currentValue.map { (item.id, $0) } }),
                    enabled: store.canSend && store.pendingActionIds.isEmpty,
                    onCategory: { proposedSetting = nil; proposedValue = nil }) { id, value in
                        proposedSetting = id; proposedValue = value
                    }
            } else {
                Text(L10n.tr("电脑端管理")).font(.orbisLabel()); Spacer()
            }
            OrbisActionButton(title: L10n.tr("应用到当前会话")) {
                guard actions.isCurrent, let setting = proposedSetting, let value = proposedValue else { return }
                if actions.updatePermission(settingId: setting, value: value) { dismiss() }
            }.disabled(!canApply)
                .padding(.horizontal, 16).padding(.bottom, 16).accessibilityIdentifier("permissions-apply")
        }.background(p.base.ignoresSafeArea())
            .onChange(of: store.selectedRuntimeId) { _, _ in dismiss() }
    }
    private var canApply: Bool {
        guard let id = proposedSetting, let value = proposedValue,
              let setting = store.selectedRuntime?.permissionManagement?.settings.first(where: { $0.id == id }) else { return false }
        return value != setting.currentValue && store.canUpdatePermission(settingId: id, value: value)
    }
    private func proposedValues(_ permissions: PermissionManagement) -> [String: String] {
        var values = Dictionary(uniqueKeysWithValues: permissions.settings.compactMap { item in item.currentValue.map { (item.id, $0) } })
        if let proposedSetting, let proposedValue { values[proposedSetting] = proposedValue }
        return values
    }

}

/// SC84: the same configuration choices as Android, using the shared iOS sheet
/// and selection rows. Submenus keep the composer draft and the current turn intact.
struct SessionModelConfigurationView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @Environment(\.colorScheme) private var scheme
    @OrbisDismiss private var dismiss
    @State private var setting: String?
    @State private var diagnosticsOpen = false
    private var actions: ChatSessionActions { ChatSessionActions(store: store, target: target, preservingRuntime: runtime) }
    let target: ChatActionContext
    let fallbackRuntime: RuntimeSummary
    private var runtime: RuntimeSummary {
        guard let current = target.owner.selectedRuntime, current.runtimeId == fallbackRuntime.runtimeId,
              current.sessionId == fallbackRuntime.sessionId else { return fallbackRuntime }
        return current
    }
    private var commands: [SlashCommand] { store.commands[runtime.runtimeId] ?? [] }
    private var command: SlashCommand? { commands.first { $0.name == setting } }
    private func select(_ name: String, _ value: String) {
        guard actions.isCurrent, store.selectedRuntime?.runtimeId == runtime.runtimeId,
              store.selectedRuntime?.sessionId == runtime.sessionId else { return }
        if actions.executeSlash(name, args: value) { dismiss() }
    }
    var body: some View {
        let presentation = store.sessionModelPresentation(runtime)
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("模型与深度"), closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "info.circle", label: L10n.tr("会话信息")) { diagnosticsOpen = true }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if presentation.showsCurrent {
                        Text(L10n.tr("本轮使用")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(presentation.model ?? L10n.tr("模型未确认"))
                            .font(.orbisBody(.semibold)).accessibilityIdentifier("session-current-model")
                        if presentation.current?.thinkingKnown == true {
                            Text(presentation.current?.thinkingLevel ?? L10n.tr("默认深度")).font(.orbisLabel())
                        }
                    }
                    if let title = presentation.selectionTitle {
                        Text(title).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Text(runtime.model.map { $0.name ?? $0.id } ?? L10n.tr("未确认"))
                            .font(.orbisBody(.semibold)).accessibilityIdentifier("session-selected-model")
                        Text(runtime.thinkingLevel ?? L10n.tr("默认深度")).font(.orbisLabel())
                    }
                    if let failure = store.sessionConfigFailure(runtime.runtimeId) {
                        Text(failure.message).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).error)
                        OrbisActionButton(title: L10n.tr("重试")) { select(failure.setting, failure.value) }.disabled(!store.canSend)
                    }
                    ForEach(OperationKinds.configSettings, id: \.self) { name in
                        if let progress = store.configStatus(runtime.runtimeId, setting: name) {
                            Text(L10n.tr("{0}，{1}", progress.label, L10n.matches(progress.mark, source: "切换中") ? L10n.tr("保存中") : progress.mark))
                                .font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }
                    if presentation.indicator == L10n.tr("未确认") {
                        OrbisActionButton(title: L10n.tr("核对配置")) { if actions.isCurrent { actions.refreshAgent() } }.disabled(!store.canSend)
                    }
                    if let command {
                        OrbisActionButton(title: L10n.tr("返回")) { setting = nil }
                        if command.argument?.options?.isEmpty != false {
                            Text(L10n.tr((command.argument?.optionCatalog?.count ?? 0) > 0 ? "加载中…" : "暂无可用选项")).font(.orbisLabel())
                        }
                        ForEach(command.argument?.options ?? []) { option in
                            OrbisChoiceRow(title: L10n.hostText(option.label), subtitle: "",
                                selected: OperationKinds.confirmedValue(runtime, setting: command.name) == option.value) {
                                select(command.name, option.value)
                            }.disabled(!store.canSend).accessibilityIdentifier("session-config-option-" + option.value)
                        }
                    } else {
                        configButton("模型", name: "model")
                        configButton("思考深度", name: OperationKinds.depthCommand(commands))
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }.accessibilityIdentifier("session-model-configuration")
        }
        .onChange(of: setting) { old, next in
            if actions.ownsRuntime, let old, target.runtimeId != nil { actions.cancelMenuOptions(old) }
            if actions.isCurrent, let next, target.runtimeId != nil { actions.loadMenuOptions(next) }
        }
        .onDisappear { if actions.ownsRuntime, let setting, target.runtimeId != nil { actions.cancelMenuOptions(setting) } }
        .orbisBottomSheet(isPresented: $diagnosticsOpen) { RuntimeInfoView(target: target, fallbackRuntime: runtime).orbisSheet([.large]) }
    }
    private func configButton(_ title: String, name: String?) -> some View {
        OrbisActionButton(title: L10n.tr(title)) { setting = name }
            .disabled(!store.canSend || !commands.contains { $0.name == name && $0.argument?.kind == "select" })
            .accessibilityIdentifier("session-config-" + (name ?? "depth"))
    }
}

private struct RuntimeInfoView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var agent: AgentState
    @Environment(\.orbisVisualActive) private var visualActive
    @OrbisDismiss private var dismiss
    private var actions: ChatSessionActions { ChatSessionActions(store: store, target: target, preservingRuntime: runtime) }
    let target: ChatActionContext
    let fallbackRuntime: RuntimeSummary
    private var runtime: RuntimeSummary {
        guard let current = target.owner.selectedRuntime, current.runtimeId == fallbackRuntime.runtimeId,
              current.sessionId == fallbackRuntime.sessionId else { return fallbackRuntime }
        return current
    }
    private var snapshot: AgentSnapshot? { agent.snapshots[runtime.runtimeId] }
    private func ready(_ name: String) -> Bool { snapshot?.missing[name] == nil && (snapshot?.domains[name]?.availability ?? "ready") == "ready" }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: L10n.tr("会话信息"), closes: true, back: { dismiss() }) {
                OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("核对会话状态")) { if actions.isCurrent { actions.refreshAgent() } }.disabled(!store.canSend)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StatusSection(title: L10n.tr("模型与上下文")) {
                        StatusFact(label: L10n.tr(runtime.status == "idle" ? "模型" : "后续模型"), value: store.configStatus(runtime.runtimeId, setting: "model").map { $0.label + L10n.tr("（") + $0.mark + L10n.tr("）") }
                                   ?? (ready("model") ? runtime.model?.name ?? runtime.model?.id ?? L10n.tr("未报告") : L10n.tr("状态待核对")))
                        StatusFact(label: L10n.tr("供应商"), value: ready("model") ? runtime.model?.provider ?? L10n.tr("未报告") : L10n.tr("状态待核对"))
                        StatusFact(label: L10n.tr(runtime.status == "idle" ? "思考级别" : "后续思考深度"), value: store.configStatus(runtime.runtimeId, setting: "thinking").map { $0.label + L10n.tr("（") + $0.mark + L10n.tr("）") }
                                   ?? (ready("model") ? runtime.thinkingLevel ?? L10n.tr("来源未报告") : L10n.tr("状态待核对")))
                        StatusFact(label: L10n.tr("上下文"), value: ready("context") ? contextText : L10n.tr("状态待核对"))
                    }
                    StatusSection(title: L10n.tr("执行状态")) {
                        StatusFact(label: L10n.tr("当前状态"), value: ready("execution") ? runtime.presentationTitle : L10n.tr("状态待核对"))
                        if ready("execution"), let execution = snapshot?.domains["execution"]?.value {
                            StatusFact(label: L10n.tr("重试"), value: activity(execution["retry"]))
                            StatusFact(label: L10n.tr("上下文压缩"), value: activity(execution["compaction"]))
                            if let start = execution["turn"]["startedAt"].number {
                                TimelineView(OrbisPausablePeriodicSchedule(interval: 1, paused: !visualActive)) { context in
                                    let duration = execution["turn"]["durationMs"].number ?? max(0, context.date.timeIntervalSince1970 * 1000 - start)
                                    StatusFact(label: execution["turn"]["durationMs"] == .null ? L10n.tr("本轮已运行") : L10n.tr("本轮耗时"), value: String(format: L10n.tr("%.1f 秒"), duration / 1000))
                                }
                            }
                        }
                    }
                    ForEach((store.commands[runtime.runtimeId] ?? []).filter { ["model", "thinking"].contains($0.name) && $0.argument?.options?.isEmpty == false }) { command in
                        StatusSection(title: command.source == "builtin" ? L10n.hostText(command.description ?? command.name) : command.description ?? command.name) {
                            ForEach(command.argument?.options ?? []) { option in
                                OrbisActionButton(title: option.label) { if actions.isCurrent { _ = actions.executeSlash(command.name, args: option.value) } }.disabled(!store.canSend)
                            }
                        }
                    }
                    StatusSection(title: L10n.tr("状态来源")) {
                        if let snapshot {
                            if let error = snapshot.error { OrbisNotice(text: error, error: true) }
                            ForEach(AgentState.domainNames, id: \.self) { name in
                                StatusFact(label: agentDomainTitle(name), value: snapshot.missing[name] ?? snapshot.domains[name].map { $0.availability == "ready" ? ($0.completeness == "complete" || $0.projectionComplete == true ? L10n.tr("已核对") : L10n.tr("部分状态")) : L10n.tr("当前不可用") } ?? L10n.tr("尚未读取"))
                            }
                        } else { Text(L10n.tr("尚未读取会话状态")).font(.orbisLabel()) }
                    }
                }.padding(20)
            }
        }
    }
    private var contextText: String {
        guard let usage = runtime.contextUsage else { return L10n.tr("来源未报告") }
        var parts: [String] = []
        if let percent = contextUsagePercent(usage) { parts.append(String(format: "%.1f%%", percent)) }
        if let tokens = usage.tokens { parts.append("\(tokens.formatted()) tokens") }
        if let window = usage.contextWindow { parts.append(L10n.tr("窗口 {0}", window.formatted())) }
        return parts.isEmpty ? L10n.tr("来源未报告") : parts.joined(separator: L10n.tr("，"))
    }
    private func activity(_ value: HostJSON) -> String {
        guard value != .null, value.string != "unavailable" else { return L10n.tr("来源尚未提供") }
        let phase = ["idle": L10n.tr("空闲"), "running": L10n.tr("进行中"), "failed": L10n.tr("失败")][value["phase"].string ?? ""] ?? L10n.tr("待核对")
        return [phase, value["attempt"].number.map { L10n.tr("第 {0} 次", Int($0)) }, value["detail"].string].compactMap { $0 }.joined(separator: L10n.tr("，"))
    }
}

private func agentDomainTitle(_ name: String) -> String {
    ["identity": L10n.tr("会话身份"), "availability": L10n.tr("可用性"), "execution": L10n.tr("执行"), "delivery": L10n.tr("消息队列"), "interactions": L10n.tr("交互"), "permissions": L10n.tr("权限"), "model": L10n.tr("模型"), "context": L10n.tr("上下文"), "capabilities": L10n.tr("可用命令"), "resources": L10n.tr("资源"), "providerBinding": L10n.tr("供应商归属"), "workspaceRef": L10n.tr("工作区"), "artifacts": L10n.tr("附件"), "records": L10n.tr("诊断记录")][name] ?? name
}
