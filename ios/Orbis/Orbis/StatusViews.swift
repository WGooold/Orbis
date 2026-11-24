import SwiftUI

/// Root settings share the same material and reserve runtime changes for an explicit apply.
struct ConnectionStatusView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    // Read through the root (PERF-12): this page stays mounted, and `@AppStorage` here would
    // re-render it on every defaults write. Choices are stored to defaults directly.
    @Environment(\.orbisAppearance) private var appearance
    @Environment(\.orbisColorMode) private var colorMode
    @Environment(\.orbisSystemVerticalBar) private var systemVerticalBar
    @EnvironmentObject private var overlay: OrbisOverlay
    @State private var connectionOpen = false
    @State private var languageOpen = false
    @State private var voiceCleanupOpen = false
    @State private var voiceCleanupUsesAPI = false
    @State private var protocolOpen = false
    @State private var proposedProtocol: RelayTransportMode = .auto
    var root = false
    let onBack: () -> Void
    var onOpenAgent: () -> Void = {}
    var body: some View {
        let palette = OrbisPalette(scheme, appearance: OrbisAppearance(rawValue: appearance) ?? .mist)
        let useSystemBar = root && systemVerticalBar
        VStack(spacing: 0) {
            if !useSystemBar {
                OrbisHeader {
                    if !root { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack) }
                } title: { Text(L10n.tr("设置")).font(.orbisTitle()) } trailing: { EmptyView() }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    StatusSection(title: L10n.tr("连接")) {
                        OrbisMotionButton { connectionOpen = true } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(OrbisPalette(scheme).secondary)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(store.selectedHost?.hostName ?? L10n.tr("电脑")).font(.orbisBody(.semibold)).lineLimit(1)
                                    Text(pathTitle(store.activePath))
                                        .font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).lineLimit(1)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                ConnectionPill(connection: store.connection, path: store.activePath, stateLabel: true)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-connection")
                        OrbisMotionButton {
                            proposedProtocol = store.relayTransportMode; protocolOpen = true
                        } label: {
                            HStack(spacing: 8) {
                                Text(L10n.tr("连接协议")).font(.orbisBody(.semibold))
                                Spacer()
                                Text(protocolTitle(store.relayTransportMode)).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                                Image(systemName: "chevron.right").font(.orbisLabel())
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-protocol")
                    }
                    StatusSection(title: "Agent") {
                        Button(action: onOpenAgent) {
                            HStack {
                                Label("Agent", systemImage: "slider.horizontal.3").font(.orbisBody(.semibold))
                                Spacer()
                                Image(systemName: "chevron.right").font(.orbisLabel()).foregroundStyle(palette.secondary)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-open-agent")
                    }
                    StatusSection(title: L10n.tr("语音")) {
                        OrbisMotionButton { voiceCleanupOpen = true } label: {
                            HStack(spacing: 8) {
                                Text(L10n.tr("语音清理")).font(.orbisBody(.semibold))
                                Spacer()
                                Text(L10n.tr(voiceCleanupUsesAPI ? "自定义模型 API" : "手机本地规则"))
                                    .font(.orbisLabel()).foregroundStyle(palette.secondary)
                                Image(systemName: "chevron.right").font(.orbisLabel()).foregroundStyle(palette.secondary)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-voice-cleanup")
                    }
                    StatusSection(title: L10n.tr("外观")) { appearancePicker.padding(.vertical, 12) }
                    StatusSection(title: L10n.tr("语言")) {
                        OrbisMotionButton { languageOpen = true } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(AppLocalization.shared.preference == .system ? L10n.tr("跟随系统") : AppLocalization.shared.preference == .chinese ? "简体中文" : "English").font(.orbisBody(.semibold))
                                    Text(AppLocalization.shared.language == .chinese ? "简体中文" : "English").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                                }
                                Spacer(); Image(systemName: "chevron.right").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                            }.frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("settings-language")
                    }
                }.padding(.horizontal, 20).padding(.vertical, 16)
            }.accessibilityIdentifier("settings-page")
        }.background(palette.base.ignoresSafeArea())
            .orbisRootSystemToolbar(enabled: useSystemBar, title: L10n.tr("设置"), titleColor: palette.text)
            .orbisBottomSheet(isPresented: $connectionOpen) { connectionSheet.orbisSheet([.medium, .large]) }
            .orbisBottomSheet(isPresented: $languageOpen) {
                VStack(spacing: 16) {
                    OrbisPageHeader(title: L10n.tr("语言"), closes: true, back: { languageOpen = false }) { EmptyView() }
                    ForEach(AppLanguage.allCases, id: \.rawValue) { choice in languageChoice(choice) }
                    Spacer(minLength: 0)
                }.padding(16).orbisSheet([.medium])
            }
            .task { voiceCleanupUsesAPI = (try? SecureStore.shared.voiceCleanupAPIConfig()) != nil }
            .orbisBottomSheet(isPresented: $voiceCleanupOpen) {
                VoiceCleanupSettings(onClose: { voiceCleanupOpen = false }, onSaved: { enabled in
                    voiceCleanupUsesAPI = enabled
                    voiceCleanupOpen = false
                }).orbisSheet([.large])
            }
            .orbisBottomSheet(isPresented: $protocolOpen) { protocolSheet.orbisSheet([.medium, .large]) }
    }
    private var connectionSheet: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: L10n.tr("当前连接"), closes: true, back: { connectionOpen = false }) { EmptyView() }
            ScrollView {
                VStack(spacing: 16) {
                    StatusRow(label: L10n.tr("连接状态"), value: connectionTitle(store.connection))
                    StatusRow(label: L10n.tr("连接延迟"), value: connectionLatencyText(store.pathRTT, connected: store.connection == .secured))
                    StatusRow(label: L10n.tr("端到端加密"), value: store.connection == .secured ? L10n.tr("已启用") : L10n.tr("未建立"))
                    ForEach(store.pairings, id: \.hostId) { pairing in
                        OrbisChoiceRow(title: pairing.hostName, subtitle: "", selected: pairing.hostId == store.selectedHostId) { store.connect(hostId: pairing.hostId) }
                    }
                    OrbisActionButton(title: L10n.tr("重新连接"), symbol: "arrow.clockwise", action: store.reconnectSelectedHost)
                        .disabled(store.selectedHost == nil || store.connection == .connecting)
                }
            }
        }.padding(16)
    }
    private var appearancePicker: some View {
        VStack(spacing: 16) {
            HStack(spacing: 16) {
                themePreview(dark: false)
                themePreview(dark: true)
            }
            Toggle(isOn: Binding(get: { colorMode == "system" }, set: { UserDefaults.standard.set($0 ? "system" : scheme == .dark ? "dark" : "light", forKey: "orbis.colorMode") })) {
                Text(L10n.tr("跟随系统")).font(.orbisBody(.semibold))
            }.toggleStyle(NeuToggleStyle()).accessibilityIdentifier("appearance-system")
            HStack {
                Text(L10n.tr("材质")).font(.orbisBody(.semibold)); Spacer()
                ForEach(OrbisAppearance.allCases, id: \.rawValue) { material in
                    let selected = appearance == material.rawValue
                    let palette = OrbisPalette(scheme, appearance: material)
                    OrbisMotionButton { UserDefaults.standard.set(material.rawValue, forKey: "orbis.appearance") } label: {
                        HStack(spacing: 8) {
                            Circle().fill(palette.base).overlay { Circle().fill(palette.accent).frame(width: 8, height: 8) }
                                .frame(width: 28, height: 28)
                                .neuSurface(inset: selected, radius: 14, intensity: 0.4, concentric: false)
                            Text(material == .mist ? L10n.tr("雾蓝") : L10n.tr("灰绿")).font(.orbisLabel(selected ? .semibold : .regular))
                        }.foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary).frame(minHeight: 48)
                    }.buttonStyle(.plain).accessibilityIdentifier("appearance-" + material.rawValue)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }
    private func themePreview(dark: Bool) -> some View {
        let selected = colorMode == "system" ? (scheme == .dark) == dark : colorMode == (dark ? "dark" : "light")
        let p = OrbisPalette(dark ? .dark : .light)
        return OrbisMotionButton { UserDefaults.standard.set(dark ? "dark" : "light", forKey: "orbis.colorMode") } label: {
            VStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(width: 44, height: 4)
                    ForEach(0..<2) { index in
                        HStack(alignment: .top, spacing: 6) {
                            Circle().fill(index == 0 ? p.success : p.faint).frame(width: 6, height: 6).padding(.top, 2)
                            VStack(alignment: .leading, spacing: 3) {
                                RoundedRectangle(cornerRadius: 2).fill(p.secondary).frame(width: index == 0 ? 54 : 62, height: 4)
                                RoundedRectangle(cornerRadius: 2).fill(p.secondary.opacity(0.65)).frame(width: 38, height: 3)
                            }
                            Spacer(minLength: 0)
                        }.padding(6).frame(height: 26).background(p.lift, in: RoundedRectangle(cornerRadius: 8))
                    }
                    HStack { Spacer(); Circle().fill(p.accent).frame(width: 10, height: 10) }
                        .padding(5).frame(height: 20)
                        .background {
                            RoundedRectangle(cornerRadius: 10).fill(p.base
                                .shadow(.inner(color: p.shadow.opacity(p.shadeOpacity), radius: 2, x: 2, y: 2))
                                .shadow(.inner(color: p.light.opacity(p.highlightOpacity), radius: 2, x: -2, y: -2)))
                        }
                }.padding(10).frame(maxWidth: .infinity).frame(height: 120).background(p.base, in: RoundedRectangle(cornerRadius: 12))
                    .neuSurface(inset: selected, radius: 16, intensity: 0.4, padding: 4, concentric: false)
                    .environment(\.colorScheme, dark ? .dark : .light)
                HStack(spacing: 6) {
                    Image(systemName: selected ? "smallcircle.filled.circle" : "circle")
                    Text(dark ? L10n.tr("深色") : L10n.tr("浅色"))
                    if selected && colorMode == "system" { Text(L10n.tr("跟随系统")).font(.orbisCaption()) }
                }.font(.orbisBody(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).secondary)
            }.frame(maxWidth: .infinity)
        }.buttonStyle(.plain).accessibilityIdentifier(dark ? "appearance-dark" : "appearance-light")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private var protocolSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            OrbisPageHeader(title: L10n.tr("连接协议"), closes: true, back: { protocolOpen = false }) { EmptyView() }
            ForEach([RelayTransportMode.auto, .ws, .quic], id: \.rawValue) { mode in
                HStack(spacing: 0) {
                    OrbisChoiceRow(title: protocolTitle(mode), subtitle: "", selected: proposedProtocol == mode) { proposedProtocol = mode }
                        .accessibilityIdentifier("relay-mode-" + mode.rawValue)
                    if mode == .quic { OrbisInfoButton(title: "QUIC", message: L10n.tr("当前网络不支持 QUIC 时无法连接")) }
                }
            }
            OrbisActionButton(title: proposedProtocol == store.relayTransportMode ? L10n.tr("正在使用") : L10n.tr("改用 {0} 并重新连接", protocolTitle(proposedProtocol))) {
                store.setRelayTransportMode(proposedProtocol); protocolOpen = false
            }.disabled(proposedProtocol == store.relayTransportMode || store.selectedHost == nil)
                .accessibilityIdentifier("relay-mode-apply")
            Spacer(minLength: 0)
        }.padding(16).background(OrbisPalette(scheme).base)
    }
    private func protocolTitle(_ mode: RelayTransportMode) -> String {
        switch mode { case .auto: L10n.tr("自动"); case .ws: "WebSocket"; case .quic: "QUIC" }
    }
    private func languageChoice(_ choice: AppLanguage) -> some View {
        let selected = AppLocalization.shared.preference == choice
        let title = choice == .system ? L10n.tr("跟随系统") : choice == .chinese ? "简体中文" : "English"
        return OrbisChoiceRow(title: title, subtitle: "", selected: selected) { AppLocalization.shared.select(choice) }
            .accessibilityIdentifier("language-\(choice.rawValue)")
    }
}

struct OrbisChoiceRow: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let subtitle: String
    let selected: Bool
    var current = false
    let action: () -> Void
    var body: some View {
        OrbisMotionButton(action: action) {
            HStack(alignment: .center, spacing: 12) {
                Circle().fill(.clear).overlay { if selected { Circle().fill(OrbisPalette(scheme).accent).padding(7) } }
                    .frame(width: 24, height: 24).neuSurface(inset: true, radius: 12, intensity: 0.4, concentric: false)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.orbisBody(.semibold)).foregroundStyle(selected ? OrbisPalette(scheme).accent : OrbisPalette(scheme).text)
                    if !subtitle.isEmpty { Text(subtitle).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize(horizontal: false, vertical: true) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if current { Text(L10n.tr("当前")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
            }.padding(12).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(NeuButtonStyle(selected: selected, radius: 16))
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// S54 / SC78: draft and live permissions share categories and compact radio rows.
struct OrbisPermissionChoices: View {
    let settings: [PermissionManagement.Setting]
    let values: [String: String]
    let currentValues: [String: String]
    var enabled = true
    var onCategory: () -> Void = {}
    let onSelect: (String, String) -> Void
    @State private var category: String?
    @Environment(\.colorScheme) private var scheme
    private var setting: PermissionManagement.Setting? { settings.first { $0.id == category } ?? settings.first }
    var body: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(settings) { item in
                        OrbisMotionButton { category = item.id; onCategory() } label: {
                            Text(L10n.hostText(item.label)).font(.orbisLabel(.semibold)).fixedSize()
                                .padding(.horizontal, 14).frame(minHeight: 48)
                        }.buttonStyle(NeuButtonStyle(selected: item.id == setting?.id, radius: 16))
                            .disabled(!enabled).accessibilityIdentifier("permission-tab-" + item.id)
                            .accessibilityAddTraits(item.id == setting?.id ? .isSelected : [])
                    }
                }.padding(.horizontal, 16).padding(.vertical, 4)
            }.fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(spacing: 12) {
                    if let setting {
                        let reason = setting.disabledReason ?? (setting.id == "network" && values["sandbox"] == "dangerFullAccess"
                            ? L10n.tr("完全访问模式允许联网，无法单独限制网络；请先选择只读或工作区可写。") : nil)
                        if let reason { OrbisStatusWithInfo(title: L10n.tr("当前不可修改"), message: L10n.hostText(reason)) }
                        ForEach(setting.options) { option in
                            HStack(spacing: 0) {
                                OrbisChoiceRow(title: L10n.hostText(option.label), subtitle: "", selected: values[setting.id] == option.value,
                                               current: currentValues[setting.id] == option.value) { onSelect(setting.id, option.value) }
                                    .disabled(!enabled || reason != nil)
                                    .accessibilityIdentifier("permission-option-" + setting.id + "-" + option.value)
                                if let description = option.description, !description.isEmpty {
                                    OrbisInfoButton(title: L10n.hostText(option.label), message: L10n.hostText(description))
                                }
                            }
                        }
                    } else { Text(L10n.tr("电脑端管理")).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary) }
                }.padding(16)
            }.frame(maxHeight: .infinity)
        }
    }
}

struct AgentProvidersView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var host: HostState
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var appearance
    @Environment(\.orbisSystemVerticalBar) private var systemVerticalBar
    @Environment(\.orbisSystemRootActions) private var systemRootActions
    @Environment(\.orbisVisible) private var visible
    @State private var selectedId: String?
    @State private var chosenKind = "codex"
    @State private var moving = false
    @State private var displayedNotice: HostConnection.AgentDialNotice?
    @State private var previousProfiles: [AgentProvider] = []
    @State private var reviewDialogID: UUID?
    var root = false
    let onBack: () -> Void
    private var owner: HostConnection { store.activeConnection }
    private var online: Bool { owner.connection == .secured }
    private let groups = ["codex", "claude", "dsh", "pi"]
    private var rows: [HostConnection.AgentEnablementRow] { owner.agentDialCached ?? owner.agentEnablementRows }
    private var managed: Bool { owner.agentEnablementAvailable || owner.agentDialCached != nil }
    private var legacyKinds: [String]? { legacyAgentDialKinds(supported: owner.supportedAgents, launchable: owner.launchableAgents) }
    private var kinds: [String] {
        managed ? rows.map(\.id) : legacyKinds ?? groups
    }
    private var kind: String { kinds.contains(chosenKind) ? chosenKind : (kinds.first ?? "") }
    // DeepSeek Desktop has a separate, read-only native catalog (ADR-0076).
    private var group: String? { kind == "codexDesktop" ? "codex" : groups.contains(kind) ? kind : nil }
    private var row: HostConnection.AgentEnablementRow? { rows.first { $0.id == kind } }
    private var label: String { row?.label ?? (kind.isEmpty ? "" : agentTitle(kind)) }
    private var powered: Bool { !managed || row?.enabled == true }
    private var visualOn: Bool { owner.agentDialVisualEnabled(kind, committed: powered) }
    private var write: HostConnection.AgentDialChoice? { owner.agentDialChoice(kind) }
    private var queued: Bool { owner.agentDialQueued(kind) }
    private var editable: Bool { visible && owner.agentDialCanEdit && row != nil && owner.agentDialReview == nil && (write == nil || queued) }
    private var profiles: [AgentProvider] { powered ? group.map { host.providers(for: $0) } ?? [] : [] }
    private var selectedIndex: Int { profiles.firstIndex { $0.id == selectedId } ?? profiles.firstIndex(where: \.enabled) ?? 0 }
    private var provider: AgentProvider? { profiles.indices.contains(selectedIndex) ? profiles[selectedIndex] : nil }
    private var palette: OrbisPalette { OrbisPalette(scheme, appearance: OrbisAppearance(rawValue: appearance) ?? .mist) }
    private func statusForKind(_ k: String) -> (String, Color) {
        let kWrite = owner.agentDialChoice(k)
        let kQueued = owner.agentDialQueued(k)
        let kRow = rows.first { $0.id == k }
        if kWrite != nil { return (kQueued ? "已排队" : "待确认", palette.accent) }
        if kRow?.enabled == false { return ("未启用", palette.faint) }
        if !online { return ("已断开", palette.faint) }
        if kRow == nil { return ("正在读取 Agent", palette.secondary) }
        if k == "codexDesktop", let facts = owner.codexDesktop {
            if facts.state == "attached" { return ("已连接", palette.success) }
            if ["notInstalled", "not_installed"].contains(facts.state) { return ("未安装", palette.warning) }
            if ["failed", "error", "incompatible"].contains(facts.state) { return ("接入失败", palette.error) }
        }
        if (owner.supportedAgents ?? []).contains(k) { return ("已连接", palette.success) }
        if (owner.launchableAgents ?? []).contains(k) { return ("可启动", palette.secondary) }
        return ("等待接入", palette.secondary)
    }
    private var sourceStatus: (String, Color) { statusForKind(kind) }
    private func refresh() {
        if managed && !owner.agentDialSynchronized { owner.refreshAgentEnablement() }
        else if powered, let group, online { host.loadProviders(group) }
    }
    private func toggle(_ target: Bool) { if editable { owner.setAgentEnabled(kind, enabled: target) } }
    private func choose(_ kind: String) { if kind != self.kind { selectedId = nil; chosenKind = kind } }
    var body: some View {
        let useSystemBar = root && systemVerticalBar
        let refreshDisabled = !online || host.changingProvider || host.providersLoading || managed && !powered && owner.agentDialSynchronized
        VStack(spacing: 0) {
            if !useSystemBar {
                OrbisHeader {
                    if !root { OrbisIconButton(symbol: "arrow.left", label: L10n.tr("返回"), action: onBack) }
                } title: { Text("Agent").font(.orbisTitle()) } trailing: {
                    OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新"), action: refresh).disabled(refreshDisabled)
                }
            }
            HStack(spacing: 12) {
                if store.pairings.count > 1 {
                    Menu {
                        ForEach(store.pairings, id: \.hostId) { pairing in
                            Button(pairing.hostName) { store.connect(hostId: pairing.hostId) }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Label(store.selectedHost?.hostName ?? L10n.tr("电脑"), systemImage: "laptopcomputer")
                            Image(systemName: "chevron.down").font(.orbisCaption())
                        }.lineLimit(1)
                    }.font(.orbisBody(.semibold)).tint(palette.text)
                } else { Label(store.selectedHost?.hostName ?? L10n.tr("电脑"), systemImage: "laptopcomputer").font(.orbisBody(.semibold)) }
                Spacer(minLength: 8)
                Text(managed ? (rows.isEmpty ? L10n.tr("正在读取 Agent") : L10n.tr("{0} / {1} 已启用", rows.filter(\.enabled).count, rows.count)) : L10n.tr("{0} 个配置", profiles.count))
                    .font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12)
            GeometryReader { geometry in
                if geometry.size.width >= 560 && geometry.size.height < 500 {
                    HStack(spacing: 0) {
                        providerDial.frame(maxWidth: .infinity, maxHeight: .infinity)
                        ScrollView { providerControls }.frame(width: min(340, geometry.size.width * 0.44))
                            .accessibilityIdentifier("provider-controls-scroll")
                    }
                } else {
                    // AGENT-DIAL-04: the facts below scroll inside their own share; they never resize the dial.
                    VStack(spacing: 0) {
                        providerDial.frame(height: ProviderDialGeometry.stackedHeight(width: geometry.size.width, height: geometry.size.height))
                        ScrollView { providerControls }.scrollBounceBehavior(.basedOnSize).frame(maxHeight: .infinity)
                    }
                }
            }
        }.background(palette.base.ignoresSafeArea())
            .orbisRootSystemToolbar(enabled: useSystemBar, showActions: systemRootActions, title: "Agent", titleColor: palette.text,
                trailingLabel: L10n.tr("刷新"), trailingSymbol: "arrow.clockwise", trailingDisabled: refreshDisabled, trailingAction: refresh)
            .task(id: DialLoadKey(host: store.selectedHostId, group: group, powered: powered, online: online, visible: visible)) {
                if visible, online, powered, let group { host.loadProviders(group) }
            }
            .onChange(of: profiles, initial: true) { _, current in if powered { previousProfiles = current } }
            .task(id: DialNoticeKey(host: store.selectedHostId, id: owner.agentDialNotice?.id)) {
                displayedNotice = owner.agentDialNotice
                guard displayedNotice?.status != "readFailed" else { return }
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { displayedNotice = nil }
            }
            .onChange(of: host.hostKey) { _, _ in previousProfiles = []; chosenKind = "codex"; selectedId = nil; moving = false; displayedNotice = nil; dismissReviewDialog() }
            .onChange(of: online) { _, value in if !value { moving = false; dismissReviewDialog() } }
            .onChange(of: owner.agentDialReview) { _, review in showReview(review) }
            .onChange(of: visible) { _, value in if value { showReview(owner.agentDialReview) } else { dismissReviewDialog(); moving = false } }
            .onAppear { showReview(owner.agentDialReview) }
            .onDisappear { dismissReviewDialog() }
    }
    private struct DialNoticeKey: Hashable { let host: String?; let id: String? }
    private struct DialLoadKey: Hashable { let host: String?; let group: String?; let powered: Bool; let online: Bool; let visible: Bool }
    private func dismissReviewDialog() {
        if let id = reviewDialogID, overlay.dialog?.id == id { overlay.dismissDialog() }
        reviewDialogID = nil
    }
    private func showReview(_ review: HostConnection.AgentDialReview?) {
        dismissReviewDialog()
        guard visible, online, let review else { return }
        let expected = owner
        let name = rows.first { $0.id == review.kind }?.label ?? review.kind
        var text = L10n.tr("Orbis 将断开此 Agent 的接入，不会退出原生应用。")
        if !review.sessions.isEmpty { text += "\n\n" + review.sessions.map { "• " + $0 }.joined(separator: "\n") }
        let extra = (review.total ?? 0) - review.sessions.count
        if extra > 0 { text += "\n" + L10n.tr("另外 {0} 个", extra) }
        overlay.showDialog(L10n.tr("停用 {0}？", name), message: text, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel) { expected.dismissAgentDialReview(review) },
            OrbisDialogAction(title: L10n.tr("停用"), role: .destructive) {
                guard store.activeConnection === expected else { return }
                expected.setAgentEnabled(review.kind, enabled: false, review: review)
            },
        ])
        reviewDialogID = overlay.dialog?.id
    }
    private var providerDial: some View {
        let statuses = Dictionary(uniqueKeysWithValues: kinds.map { ($0, statusForKind($0)) })
        let activeSessionCount = online && powered ? owner.runtimes.filter { $0.agentKind == kind }.count : 0
        let externalSubtitle: String? = if displayedNotice?.kind == kind, let s = displayedNotice?.status, s == "externalOn" || s == "externalOff" {
            s == "externalOn" ? "其他设备已启用" : "其他设备已停用"
        } else { nil }
        let errorReason: String? = kind == "codexDesktop" && powered && online && sourceStatus.1 == palette.error ? owner.codexDesktop?.reason : nil
        let pinRests = Dictionary(uniqueKeysWithValues: kinds.map { k in
            (k, ProviderDialGeometry.pinRest(pendingTarget: owner.agentDialChoice(k)?.target, enabled: rows.first { $0.id == k }?.enabled == true))
        })
        return ProviderDialView(kinds: kinds, kind: kind, providers: visualOn && !powered ? previousProfiles : profiles, selected: selectedIndex,
            onKind: choose, onSelect: { if profiles.indices.contains($0) { selectedId = profiles[$0].id } }, onMoving: { moving = $0 },
            rows: rows, statuses: statuses, pinRests: pinRests, label: label, status: sourceStatus.0, statusColor: sourceStatus.1, managed: managed, powered: visualOn,
            offline: !online, editable: editable, pending: write, queued: queued,
            activeSessionCount: activeSessionCount, externalSubtitle: externalSubtitle, errorReason: errorReason,
            autoNudge: editable && !rows.isEmpty && rows.allSatisfy { !$0.enabled },
            conflictID: displayedNotice?.kind == kind && displayedNotice?.status == "conflict" ? displayedNotice?.id : nil,
            onToggle: toggle)
            .id(store.selectedHostId)
            .overlay(alignment: .trailing) {
                if !managed && profiles.isEmpty && group != nil {
                    if host.providersLoading { ProgressView().accessibilityLabel(L10n.tr("正在读取供应商")).padding(.trailing, 24) }
                    else if host.providerCatalogProblem == nil { Text(L10n.tr("还没有供应商")).font(.orbisBody()).foregroundStyle(palette.secondary).padding(.trailing, 24) }
                }
            }.accessibilityIdentifier("provider-dial-area")
    }
    private var providerControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            let activeSessions = online && powered ? owner.runtimes.filter { $0.agentKind == kind } : []
            let quotaReady = provider?.subscriptionSupported == true && provider?.enabled == true
            // AGENT-DIAL-05: the facts slot, the action and the position line hold the same place for every Agent;
            // the slot shows one fact at a time and prompts only follow, so switching never moves the action.
            ZStack(alignment: .topLeading) {
                if !activeSessions.isEmpty && !quotaReady {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(activeSessions.prefix(2)), id: \.runtimeId) { runtime in
                            let title = (runtime.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                                ?? (runtime.name.isEmpty ? runtime.runtimeId : runtime.name)
                            HStack(spacing: 8) {
                                Circle().fill(palette.success).frame(width: 8, height: 8)
                                Text(title).font(.orbisCaption()).foregroundStyle(palette.text).lineLimit(1)
                            }
                        }
                        let remaining = activeSessions.count - 2
                        Text(remaining > 0 ? L10n.tr("另外 {0} 个", remaining) : L10n.tr("{0} 个会话", activeSessions.count))
                            .font(.orbisCaption()).foregroundStyle(palette.success)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .neuSurface(inset: true, radius: 12, intensity: 0.35, concentric: false)
                        .accessibilityIdentifier("provider-running-sessions")
                } else if powered && group != nil && (provider != nil || !managed) { quotaPanel }
            }.frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
            if let write {
                OrbisActionButton(title: L10n.tr(write.target ? "正在启用" : "正在停用"), symbol: "clock") {}.disabled(true)
            } else if managed && row == nil {
                OrbisActionButton(title: L10n.tr("正在读取 Agent")) {}.disabled(true)
            } else if managed && !powered {
                OrbisActionButton(title: L10n.tr("启用 {0}", label), symbol: "power", tint: palette.agent(kind)) { toggle(true) }
                    .disabled(!editable || moving).accessibilityIdentifier("agent-enable-action")
            } else if let provider {
                let active = provider.enabled && !provider.additive
                OrbisActionButton(title: actionTitle(provider), symbol: active ? "checkmark" : provider.additive ? (provider.enabled ? "xmark" : "plus") : "arrow.left.arrow.right", tint: palette.agent(provider.kind)) { apply(provider) }
                    .disabled(active || moving || !online || !host.canChangeProvider(for: provider.kind))
                    .accessibilityIdentifier("provider-action-" + provider.id)
            } else {
                OrbisActionButton(title: L10n.tr(managed && group == nil ? "已启用" : host.providersLoading ? "正在读取供应商" : "当前没有可用供应商"), symbol: managed && group == nil ? "checkmark" : nil) {}.disabled(true)
            }
            // Prompts share the line under the action with the position, so the first one stays in view
            // and any more only grow downward; nothing above the action ever moves for them.
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    if powered, let group, let problem = host.providerCatalogProblem(for: group) {
                        Label(problem, systemImage: "exclamationmark.circle").font(.orbisCaption())
                            .foregroundStyle(online ? palette.error : palette.secondary).accessibilityIdentifier("provider-catalog-problem")
                    }
                    if powered && group != nil, let provider, provider.enabled && provider.subscriptionSupported, let error = host.subscriptionQuota(for: provider)?.error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.orbisCaption()).foregroundStyle(palette.error)
                            .accessibilityIdentifier("provider-quota-error")
                    }
                    if kind == "codexDesktop", powered, online, let reason = owner.codexDesktop?.reason, sourceStatus.1 == palette.error {
                        Text(reason).font(.orbisCaption()).foregroundStyle(palette.error)
                    }
                    if !online {
                        Text(owner.agentDialLastSync.map { L10n.tr("等待电脑连接 · 上次同步 {0}", $0.formatted(date: .omitted, time: .shortened)) } ?? L10n.tr("等待电脑连接"))
                            .font(.orbisCaption()).foregroundStyle(palette.warning)
                    }
                    if powered, group == host.providerKind, let notice = host.providerNotice { OrbisNotice(text: notice).accessibilityIdentifier("provider-notice") }
                    if let feedback = displayedNotice { feedbackRow(feedback) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if !profiles.isEmpty || !managed {
                    Text("\(profiles.isEmpty ? 0 : selectedIndex + 1) / \(profiles.count)")
                        .accessibilityLabel(L10n.tr("配置 {0} / {1}", profiles.isEmpty ? 0 : selectedIndex + 1, profiles.count))
                        .accessibilityIdentifier("provider-position")
                        .font(.orbisCaption()).foregroundStyle(palette.secondary)
                }
            }.frame(minHeight: 20, alignment: .top)
        }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 16)
    }
    private func feedbackRow(_ feedback: HostConnection.AgentDialNotice) -> some View {
        let name = rows.first { $0.id == feedback.kind }?.label ?? label
        let text: String = switch feedback.status {
        case "disabled": L10n.tr("已停用 {0}", name)
        case "externalOn": L10n.tr("{0} 已在其他设备启用", name)
        case "externalOff": L10n.tr("{0} 已在其他设备停用", name)
        case "conflict": L10n.tr("Agent 设置已在其他设备更新，请确认后重试")
        case "interrupted": L10n.tr(owner.agentDialSynchronized ? "已按电脑同步" : "未确认，等待电脑同步")
        default: L10n.tr("无法读取或保存 Agent 设置")
        }
        return HStack {
            Text(text).font(.orbisCaption()).foregroundStyle(palette.secondary)
            Spacer(minLength: 0)
            if feedback.status == "disabled", let kind = feedback.kind, owner.agentDialCanEdit, feedback.revision == owner.agentEnablementRevision {
                Button(L10n.tr("撤销")) { owner.setAgentEnabled(kind, enabled: true, expectedRevision: feedback.revision); displayedNotice = nil }
            } else if feedback.status == "readFailed", online { Button(L10n.tr("刷新"), action: owner.refreshAgentEnablement) }
        }
    }
    private var quotaPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let provider, provider.enabled && provider.subscriptionSupported {
                let snapshot = host.subscriptionQuota(for: provider)
                let loading = host.isQueryingQuota(for: provider)
                HStack(alignment: .top, spacing: 20) {
                    ForEach(["five_hour", "seven_day"], id: \.self) { name in
                        ProviderQuotaCell(name: name, window: snapshot?.quota?.windows.first { $0.name == name },
                            loading: loading, failed: snapshot?.error != nil, tint: palette.agent(provider.kind))
                    }
                    OrbisIconButton(symbol: "arrow.clockwise", label: L10n.tr("刷新配额"), compact: true) {
                        if let key = host.hostKey { host.querySubscription(provider, expectedHostKey: key) }
                    // Same precondition as querySubscription: an enabled refresh always sends a fresh read.
                    }.disabled(!host.canChangeProvider(for: provider.kind)).accessibilityIdentifier("provider-quota-refresh")
                }
            } else {
                OrbisStatusWithInfo(title: L10n.tr("配额不可用"), message: L10n.tr("这个配置不提供配额查询"))
            }
        }.frame(minHeight: 112, alignment: .top)
    }
    private func actionTitle(_ provider: AgentProvider) -> String {
        if provider.additive { return provider.enabled ? L10n.tr("移出 {0}", provider.name) : L10n.tr("启用 {0}", provider.name) }
        return provider.enabled ? L10n.tr("正在使用 {0}", provider.name) : L10n.tr("切换到 {0}", provider.name)
    }
    private func apply(_ provider: AgentProvider) {
        guard !moving, powered, online, let key = host.hostKey, host.canChangeProvider(for: provider.kind) else { return }
        let removing = provider.additive && provider.enabled
        overlay.showDialog(removing ? L10n.tr("移出 {0}？", provider.name) : L10n.tr("切换 {0} 到 {1}？", agentTitle(provider.kind), provider.name), message: provider.confirmation, actions: [
            OrbisDialogAction(title: L10n.tr("取消"), role: .cancel),
            OrbisDialogAction(title: removing ? L10n.tr("移出") : provider.additive ? L10n.tr("启用") : L10n.tr("切换"), role: removing ? .destructive : .normal) {
                OrbisHaptics.commit()
                if removing { host.removeProviders([provider], expectedHostKey: key) }
                else { host.changeProvider(provider, expectedHostKey: key) }
            }
        ])
    }
}

private struct ProviderQuotaCell: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    let window: SubscriptionQuota.Window?
    let loading: Bool
    let failed: Bool
    let tint: Color
    var body: some View {
        let p = OrbisPalette(scheme)
        let remaining = window?.remainingPercent
        let low = (remaining ?? 100) <= 20
        let ink = low ? p.error : tint
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Text(name == "five_hour" ? L10n.tr("5 小时") : L10n.tr("7 天")).font(.orbisLabel())
                if low { Image(systemName: "exclamationmark.triangle").font(.system(size: 14)).foregroundStyle(p.error) }
            }.foregroundStyle(p.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(remaining.map { String(format: "%.0f", $0) } ?? "—").font(.orbisDisplay()).foregroundStyle(low ? p.error : p.text)
                if remaining != nil { Text("%").font(.orbisLabel()).foregroundStyle(p.secondary) }
            }
            GeometryReader { proxy in
                Capsule().fill(.clear).neuSurface(inset: true, radius: 3, intensity: 0.4, concentric: false)
                    .overlay(alignment: .leading) { Capsule().fill(ink).frame(width: proxy.size.width * min(1, max(0, (remaining ?? 0) / 100))) }
            }.frame(height: 6)
            if loading { Text(L10n.tr("正在查询")).font(.orbisCaption()).foregroundStyle(p.secondary) }
            else if let reset = window?.resetsAt {
                Text(subscriptionQuotaResetCountdown(resetsAt: reset, now: Date()))
                    .font(.orbisCaption()).foregroundStyle(p.secondary)
                    .accessibilityIdentifier("provider-quota-reset-" + name)
            } else { Text(L10n.tr(failed || window != nil ? "暂不可用" : "待查询")).font(.orbisCaption()).foregroundStyle(p.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("provider-quota-" + name)
    }
}

private struct ProviderDialView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisReduceMotion) private var reduced
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisVisible) private var visible
    @State private var keyboardHandle: ProviderDialGeometry.Handle?
    @GestureState private var dragging = false
    let kinds: [String]
    let kind: String
    let providers: [AgentProvider]
    let selected: Int
    let onKind: (String) -> Void
    let onSelect: (Int) -> Void
    let onMoving: (Bool) -> Void
    let rows: [HostConnection.AgentEnablementRow]
    let statuses: [String: (String, Color)]
    let pinRests: [String: Double]
    let label: String
    let status: String
    let statusColor: Color
    let managed: Bool
    let powered: Bool
    let offline: Bool
    let editable: Bool
    let pending: HostConnection.AgentDialChoice?
    let queued: Bool
    let activeSessionCount: Int
    let externalSubtitle: String?
    let errorReason: String?
    let autoNudge: Bool
    let conflictID: String?
    let onToggle: (Bool) -> Void
    @State private var nudged = false
    @State private var recoil = 0.0
    @State private var sweep = 1.0
    @State private var dimSweep = 0.0
    @State private var showStatusInfo = false
    @State private var pinDrag: Double?
    @State private var pinOwner: String?
    @State private var pinStartEnabled = false
    @State private var pinStartChoice: HostConnection.AgentDialChoice?
    @State private var pinArmed = false
    @State private var pinTouched = false
    @State private var axisLocked = false
    @State private var hint: String?
    @State private var nudge = 0.0
    @State private var hintTask: Task<Void, Never>?
    @State private var ringLit = false
    @State private var groupPosition = 0.0
    @State private var profilePosition = 0.0
    @State private var handle: ProviderDialGeometry.Handle?
    @State private var gestureStarted = false
    @State private var initialPosition = 0.0
    @State private var moved = false
    @State private var agentPulse = 0
    @State private var profilePulse = 0
    /// The selected Agent's resting pin travel, animated only while the same Agent stays selected.
    @State private var restTravel = 0.0
    private var groupIndex: Int { kinds.firstIndex(of: kind) ?? 0 }
    private var actualPower: Bool { !managed || ringLit }
    private var pinRest: Double { ProviderDialGeometry.pinRest(pendingTarget: pending?.target, enabled: powered) }
    private var selectedTravel: Double { pinDrag ?? (restTravel + nudge) }
    private struct PinRestKey: Equatable { let kind: String; let rest: Double }
    private var pinColor: Color { conflictID != nil ? palette.error : offline || !powered && pending == nil ? palette.faint : palette.agent(kind) }
    private var palette: OrbisPalette { OrbisPalette(scheme) }
    var body: some View {
        GeometryReader { proxy in
            let g = ProviderDialGeometry.Layout(width: proxy.size.width, height: proxy.size.height)
            ZStack(alignment: .topLeading) {
                disc(radius: g.radius, inset: managed && !actualPower, intensity: actualPower ? 1 : 0.45)
                    .overlay { if keyboardHandle == .profile { Circle().stroke(palette.agent(kind), lineWidth: 2).padding(4) } }
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.upArrow, .downArrow, .home, .end]) { key in keyboardBrowse(.profile, key: key.key) }
                    .onKeyPress(.tab, phases: .down) { key in
                        if key.modifiers.contains(.shift) { return .ignored }
                        keyboardHandle = .agent; return .handled
                    }
                    .accessibilityElement().accessibilityLabel(L10n.tr("供应商圆盘"))
                    .accessibilityValue(providers.indices.contains(selected) ? providers[selected].name : L10n.tr("还没有供应商"))
                    .accessibilityIdentifier("provider-profile-keyboard")
                    .position(x: g.centerX, y: g.centerY)
                profileScale(g)
                disc(radius: g.hubRadius + 24, inset: true, intensity: 0.4).position(x: g.centerX, y: g.centerY)
                let hubIntensity: CGFloat = handle == .agent ? 1 : 0.4
                disc(radius: g.hubRadius, intensity: hubIntensity)
                    .overlay { if keyboardHandle == .agent { Circle().stroke(palette.agent(kind), lineWidth: 2).padding(4) } }
                    .focusEffectDisabled()
                    .onKeyPress(keys: [.upArrow, .downArrow, .home, .end, .leftArrow, .rightArrow, .space]) { key in keyboardBrowse(.agent, key: key.key) }
                    .onKeyPress(.tab, phases: .down) { key in
                        if key.modifiers.contains(.shift) { keyboardHandle = .profile; return .handled }
                        return .ignored
                    }
                    .accessibilityElement().accessibilityLabel("Agent").accessibilityValue(agentTitle(kind))
                    .accessibilityIdentifier("provider-agent-keyboard")
                    .position(x: g.centerX, y: g.centerY)
                ForEach(0..<45, id: \.self) { tick in
                    let angle = Double(tick * 8) * .pi / 180
                    Circle().fill(palette.faint.opacity(0.5)).frame(width: 3, height: 3)
                        .position(x: g.centerX + (g.hubRadius - 8) * cos(angle), y: g.centerY + (g.hubRadius - 8) * sin(angle))
                }
                // AGENT-DIAL-04: the groove is fixed hardware at the gate and never leaves; each Agent is
                // drawn once and its pin retracts or extends along the groove as the ring docks it.
                if managed && !kind.isEmpty { pinGroove(g) }
                if !managed {
                    Color.clear.frame(width: 36, height: 36).neuSurface(inset: true, radius: 18, intensity: 0.4, concentric: false)
                        .modifier(OrbisDialPulse(trigger: agentPulse, peak: 1.08))
                        .position(x: g.centerX + g.agentRadius, y: g.centerY)
                }
                DialAgentRing(position: groupPosition, travel: selectedTravel, g: g, kinds: kinds, kind: kind, managed: managed,
                    dimmed: handle == .profile, rests: pinRests, palette: palette, conflict: conflictID != nil, recoil: recoil,
                    offline: offline, enabled: agentEnabled, onTap: settleAgent) { agent, gate in agentBead(agent, gate: gate) }
                disc(radius: g.holeRadius, inset: true, intensity: 0.65).position(x: g.centerX, y: g.centerY)
                Circle().fill(!managed ? palette.agent(kind) : actualPower && !offline && status == "已连接" ? statusColor : .clear)
                    .overlay { if managed && (!actualPower || offline || status != "已连接") { Circle().strokeBorder(actualPower && !offline ? statusColor : palette.faint, lineWidth: 1.1) } }
                    .frame(width: 7, height: 7).modifier(OrbisDialPulse(trigger: profilePulse, peak: 1.5))
                    .position(x: g.centerX + g.radius + 8, y: g.centerY)
                OrbisDialSweep(progress: sweep, tint: palette.agent(kind), geometry: g)
                    .opacity(managed && !offline && !reduced ? 1 : 0).allowsHitTesting(false)
                if dimSweep > 0.01 {
                    OrbisDialSweep(progress: dimSweep, tint: palette.faint, geometry: g)
                        .opacity(managed && !offline && !reduced ? 0.8 : 0).allowsHitTesting(false)
                }
                if managed && powered && !offline && !reduced && (status.hasPrefix("准备") || status.hasPrefix("正在") || status.hasPrefix("安装")) {
                    TimelineView(.animation) { timeline in
                        let angle = (timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4) * 360
                        Path { path in
                            path.addArc(center: CGPoint(x: g.centerX, y: g.centerY), radius: g.radius - 12,
                                        startAngle: .degrees(angle - 36), endAngle: .degrees(angle + 36), clockwise: false)
                        }.stroke(palette.agent(kind).opacity(0.55), lineWidth: 2)
                    }.allowsHitTesting(false)
                }
                if managed && !kind.isEmpty { pinAccessibility(g) }
                if managed && profilesHidden && !kind.isEmpty { nameplate(g) }
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped()
                .contentShape(Rectangle()).gesture(gesture(g))
                .background {
                    OrbisDialKeyboardBridge(active: visible && scenePhase == .active, pinEditable: managed && editable,
                        focus: Binding(get: { keyboardHandle }, set: { keyboardHandle = $0 }),
                        browse: { owner, key in _ = keyboardBrowse(owner, key: key) })
                }
                .accessibilityElement(children: .contain)
                .overlay(alignment: .leading) {
                    Color.clear.frame(width: max(48, g.centerX + g.hubRadius), height: 48)
                        .accessibilityElement().accessibilityLabel("Agent").accessibilityValue(agentTitle(kind))
                        .accessibilityAdjustableAction { direction in adjustAgent(direction) }
                }
                .accessibilityLabel(L10n.tr(managed ? "Agent 转盘" : "供应商圆盘"))
                .accessibilityValue(providers.indices.contains(selected) ? providers[selected].name : L10n.tr(status))
                .accessibilityAdjustableAction { direction in
                    let next = max(0, min(providers.count - 1, selected + (direction == .increment ? 1 : -1)))
                    settleProfile(next)
                }
        }.onAppear {
            groupPosition = Double(groupIndex); profilePosition = Double(selected); ringLit = powered; restTravel = pinRest
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-provider-keyboard") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { keyboardHandle = .profile }
            }
            #endif
        }
            .onChange(of: dragging) { old, active in if old && !active { resetGesture() } }
            .onChange(of: visible) { _, active in if !active { keyboardHandle = nil; resetGesture() } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { keyboardHandle = nil; resetGesture() } }
            .onDisappear { keyboardHandle = nil; resetGesture(); hintTask?.cancel() }
            .onChange(of: kinds) { _, _ in resetGesture(); groupPosition = Double(groupIndex) }
            .task(id: autoNudge && visible) {
                guard visible, autoNudge, !nudged else { return }
                try? await Task.sleep(for: .milliseconds(900))
                guard !Task.isCancelled else { return }
                nudged = true; nudgePin()
                try? await Task.sleep(for: .milliseconds(540))
                if !Task.isCancelled { nudgePin() }
            }
            .task(id: conflictID) {
                recoil = 0
                guard conflictID != nil, !reduced else { return }
                for offset in [-4.0, 3.0, 0.0] {
                    withAnimation(.easeOut(duration: 0.055)) { recoil = offset }
                    try? await Task.sleep(for: .milliseconds(55)); if Task.isCancelled { return }
                }
            }
            .task(id: powered) {
                if managed && powered && !ringLit && !offline {
                    dimSweep = 0
                    if !reduced { try? await Task.sleep(for: .milliseconds(170)) }
                    guard !Task.isCancelled else { return }
                    withAnimation(reduced ? nil : InteractionMotion.state) { ringLit = true }
                    if !reduced {
                        sweep = 0
                        withAnimation(.easeOut(duration: 0.58)) { sweep = 1 }
                    }
                    OrbisHaptics.commit()
                } else if managed && !powered && ringLit && !offline {
                    withAnimation(reduced ? nil : InteractionMotion.state) { ringLit = false }
                    if !reduced {
                        dimSweep = 1
                        withAnimation(.easeOut(duration: 0.52)) { dimSweep = 0 }
                    }
                } else { ringLit = powered; dimSweep = 0 }
            }
            .onChange(of: kind) { _, _ in
                showStatusInfo = false
                agentPulse += 1
                if handle == nil { groupPosition = Double(groupIndex) }
                withAnimation(reduced ? nil : InteractionMotion.state) { profilePosition = Double(selected) }
            }
            .onChange(of: selected) { _, index in if handle == nil { profilePosition = Double(index) } }
            // A newly selected Agent starts from its own rest, never mid-way from the previous Agent's pin.
            .onChange(of: PinRestKey(kind: kind, rest: pinRest)) { old, new in
                if old.kind == new.kind && !reduced { withAnimation(.easeOut(duration: 0.17)) { restTravel = new.rest } }
                else { restTravel = new.rest }
            }
    }
    private func disc(radius: Double, inset: Bool = false, intensity: CGFloat) -> some View {
        Circle().fill(.clear).frame(width: radius * 2, height: radius * 2)
            .neuSurface(inset: inset, radius: radius, intensity: intensity, concentric: false)
            .environment(\.orbisSurface, nil)
    }
    private func agentEnabled(_ agent: String) -> Bool { agent == kind ? powered : rows.first { $0.id == agent }?.enabled == true }
    /// One Agent's face on the ring; the selected Agent shows its pending write in place of its mark.
    @ViewBuilder private func agentBead(_ agent: String, gate: Double) -> some View {
        if managed && agent == kind && pending != nil {
            if queued { Circle().strokeBorder(pinColor, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])).padding(7) }
            else if reduced { Circle().trim(from: 0, to: 0.72).stroke(pinColor, style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).padding(7) }
            else { ProgressView().tint(pinColor) }
        } else {
            let enabled = agentEnabled(agent)
            let agentStatus = statuses[agent] ?? (status, statusColor)
            dialMark(agent, muted: offline || !enabled, emphasis: gate)
                .frame(width: 44, height: 44)
                .overlay {
                    if managed { dialBadges(agent, showStatusDot: enabled && !offline, statusLabel: agentStatus.0, statusTone: agentStatus.1) }
                }
        }
    }
    @ViewBuilder private func dialBadges(_ id: String, showStatusDot: Bool, statusLabel: String, statusTone: Color) -> some View {
        ZStack {
            if showStatusDot {
                Group {
                    if statusLabel == "可启动" {
                        Circle().strokeBorder(palette.secondary, lineWidth: 1.5).frame(width: 7, height: 7)
                    } else {
                        Circle().fill(statusTone).frame(width: 7, height: 7)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(5)
            }
            if let variant = ProviderDialGeometry.variant(for: id) {
                Circle().fill(.clear).frame(width: 14, height: 14)
                    .neuSurface(radius: 7, intensity: 0.25, concentric: false)
                    .environment(\.orbisSurface, nil)
                    .overlay {
                        Image(systemName: variant == "terminal" ? "terminal" : "display")
                            .font(.system(size: 7.5, weight: .semibold)).foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(2)
            }
        }
    }
    private var subtitleInfo: (String, Color)? {
        if let externalSubtitle { return (externalSubtitle, palette.agent(kind)) }
        if let errorReason { return (errorReason, palette.error) }
        if powered && !offline && activeSessionCount > 0 { return (L10n.tr("{0} 个运行中", activeSessionCount), palette.success) }
        return nil
    }
    private func profileScale(_ g: ProviderDialGeometry.Layout) -> some View {
        ZStack {
            Canvas { context, _ in
                for index in -60...60 {
                    let angle = (Double(index * 3) - profilePosition * g.profileStep) * .pi / 180
                    let major = index % 6 == 0
                    var path = Path()
                    let outer = g.radius - 10, inner = outer - (major ? 14 : index % 2 == 0 ? 9 : 5)
                    path.move(to: CGPoint(x: g.centerX + inner * cos(angle), y: g.centerY + inner * sin(angle)))
                    path.addLine(to: CGPoint(x: g.centerX + outer * cos(angle), y: g.centerY + outer * sin(angle)))
                    context.stroke(path, with: .color(palette.faint.opacity(offline ? 0.32 : actualPower ? 1 : 0.28)), lineWidth: 1)
                }
            }
            ForEach(Array((actualPower ? providers : []).enumerated()), id: \.element.id) { index, provider in
                let delta = Double(index) - profilePosition
                let angle = delta * g.profileStep * .pi / 180
                let x = g.centerX + (g.radius + 28) * cos(angle), y = g.centerY + (g.radius + 28) * sin(angle)
                if abs(delta) <= 3.5 && x >= 20 {
                    VStack(alignment: .leading, spacing: 4) {
                        if abs(delta) < 0.5 { Text(label).font(.orbisCaption()).foregroundStyle(palette.agent(kind)) }
                        Text(provider.name).font(abs(delta) < 0.5 ? .orbisTitle() : .orbisBody()).lineLimit(1)
                            .foregroundStyle(abs(delta) < 0.5 ? palette.text : palette.secondary)
                        if abs(delta) < 0.5 {
                            Text(provider.official ? L10n.tr("官方") : L10n.tr("自定义配置")).font(.orbisCaption()).foregroundStyle(palette.secondary)
                            if managed && (hint != nil || status != "已连接") {
                                HStack(spacing: 4) {
                                    Text(L10n.tr(hint ?? status)).font(.orbisCaption()).foregroundStyle(statusColor)
                                    if let info = ProviderDialGeometry.infoHint(for: status), hint == nil {
                                        Button { showStatusInfo.toggle() } label: {
                                            Image(systemName: "info.circle").font(.system(size: 13)).foregroundStyle(palette.secondary)
                                        }.buttonStyle(.plain).accessibilityLabel(L10n.tr(info))
                                    }
                                }
                                if showStatusInfo, let info = ProviderDialGeometry.infoHint(for: status), hint == nil {
                                    Text(L10n.tr(info)).font(.orbisCaption()).foregroundStyle(palette.secondary)
                                }
                            }
                            if let sub = subtitleInfo {
                                Text(sub.0).font(.orbisCaption()).foregroundStyle(sub.1).lineLimit(2)
                            }
                            if provider.enabled { Text(provider.additive ? L10n.tr("已启用") : L10n.tr("使用中")).font(.orbisCaption()).foregroundStyle(palette.success) }
                        }
                    }.frame(width: max(136, g.width - x - 8), alignment: .leading)
                        .opacity(handle == .agent ? 0.4 : max(0.25, 1 - abs(delta) * 0.22))
                        .position(x: x + max(136, g.width - x - 8) / 2, y: y)
                        .onTapGesture { settleProfile(index) }
                    Circle().fill(provider.enabled ? palette.success : palette.faint).frame(width: 5, height: 5)
                        .position(x: g.centerX + (g.radius - 32) * cos(angle), y: g.centerY + (g.radius - 32) * sin(angle))
                }
            }
        }.opacity(handle == .agent ? 0.4 : 1)
    }
    private var profilesHidden: Bool { !actualPower || providers.isEmpty }
    @ViewBuilder private func dialMark(_ id: String, muted: Bool, emphasis: Double = 1) -> some View {
        if AgentIdentity(kind: id) != nil { AgentEmblem(kind: id, size: 20, recessed: false).saturation(muted ? 0 : emphasis).opacity(muted ? 0.66 : 0.66 + 0.34 * emphasis) }
        else { Image(systemName: "terminal").font(.system(size: 18, weight: .semibold)).foregroundStyle(palette.faint) }
    }
    private func nameplate(_ g: ProviderDialGeometry.Layout) -> some View {
        let x = g.centerX + g.radius + 28
        let width = max(64, min(150, g.width - x - 12))
        let info = ProviderDialGeometry.infoHint(for: status)
        return VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.orbisCaption()).foregroundStyle(powered && !offline ? palette.agent(kind) : palette.faint)
            HStack(spacing: 6) {
                Text(L10n.tr(hint ?? status)).font(.orbisTitle()).foregroundStyle(statusColor).lineLimit(2)
                if info != nil && hint == nil {
                    Button { showStatusInfo.toggle() } label: {
                        Image(systemName: "info.circle").font(.system(size: 15)).foregroundStyle(palette.secondary)
                    }.buttonStyle(.plain).accessibilityIdentifier("provider-status-info")
                }
            }
            if showStatusInfo, let info, hint == nil {
                Text(L10n.tr(info)).font(.orbisCaption()).foregroundStyle(palette.secondary).lineLimit(3)
            }
            if let sub = subtitleInfo {
                Text(sub.0).font(.orbisCaption()).foregroundStyle(sub.1).lineLimit(2)
            }
        }.frame(width: width, alignment: .leading).position(x: x + width / 2, y: g.centerY - 4)
    }
    private func pinGroove(_ g: ProviderDialGeometry.Layout) -> some View {
        Capsule().fill(.clear).frame(width: g.pinTravel + 44, height: 44)
            .neuSurface(inset: true, radius: 22, intensity: 0.55, concentric: false).environment(\.orbisSurface, nil)
            .overlay {
                if pinArmed { Capsule().strokeBorder(palette.agent(kind).opacity(0.8), lineWidth: 2) }
            }
            .position(x: g.pinStart + g.pinTravel / 2, y: g.centerY).allowsHitTesting(false)
    }
    private func pinAccessibility(_ g: ProviderDialGeometry.Layout) -> some View {
        ZStack {
            Color.clear.frame(width: g.pinTravel + 48, height: 48)
                .position(x: g.pinStart + g.pinTravel / 2, y: g.centerY)
                .accessibilityElement().accessibilityLabel(label).accessibilityValue(L10n.tr(hint ?? status))
                .accessibilityAddTraits(.isToggle).accessibilityIdentifier("agent-enablement-" + kind)
                .accessibilityAction { if editable { onToggle(!(pending?.target ?? powered)) } }
                .accessibilityAction(named: Text(L10n.tr((pending?.target ?? powered) ? "停用" : "启用"))) {
                    if editable { onToggle(!(pending?.target ?? powered)) }
                }.disabled(!editable)
        }.frame(width: g.width, height: g.height).allowsHitTesting(false)
    }
    private func nudgePin() {
        guard editable, pending == nil else { return }
        hintTask?.cancel()
        hint = powered ? "向内拉停用" : "向外推启用"
        if !reduced { withAnimation(.easeOut(duration: 0.17)) { nudge = powered ? -0.16 : 0.16 } }
        hintTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300)); guard !Task.isCancelled else { return }
            withAnimation(reduced ? nil : .easeOut(duration: 0.22)) { nudge = 0 }
            try? await Task.sleep(for: .milliseconds(1050)); if !Task.isCancelled { hint = nil }
        }
    }
    private func gesture(_ g: ProviderDialGeometry.Layout) -> some Gesture {
        DragGesture(minimumDistance: 0).updating($dragging) { _, active, _ in active = true }.onChanged { value in
            let dx = value.translation.width, dy = value.translation.height
            if !gestureStarted {
                gestureStarted = true; pinTouched = managed && g.pinContains(x: value.startLocation.x, y: value.startLocation.y)
                handle = g.handle(x: value.startLocation.x, y: value.startLocation.y) ?? (pinTouched ? .agent : nil)
                initialPosition = handle == .agent ? Double(groupIndex) : profilePosition
                moved = false; axisLocked = false; pinArmed = false
                pinStartEnabled = pending?.target ?? powered; pinStartChoice = pending
            }
            if !axisLocked {
                guard managed ? hypot(dx, dy) >= 8 : abs(dy) >= (handle == .agent ? 10 : 4) else { return }
                axisLocked = true; moved = true
                if managed && ProviderDialGeometry.horizontal(dx, dy) {
                    handle = nil
                    if pinTouched && editable { pinOwner = kind; hintTask?.cancel() }
                } else if handle == .agent && kinds.isEmpty || handle == .profile && providers.isEmpty { handle = nil }
                if handle != nil { onMoving(true) }
            }
            if let pinOwner {
                guard editable, pinOwner == kind, pinStartChoice == pending, pinStartEnabled == (pending?.target ?? powered) else {
                    self.pinOwner = nil; pinDrag = nil; pinArmed = false; hint = nil; return
                }
                let position = ProviderDialGeometry.pinPosition(enabled: pinStartEnabled, dx: dx, travel: g.pinTravel)
                pinDrag = position
                let next = ProviderDialGeometry.pinArmed(enabled: pinStartEnabled, position: position)
                if next && !pinArmed { OrbisHaptics.selectionChanged() }
                pinArmed = next; hint = next ? ProviderDialGeometry.pinReleaseHint(effectiveEnabled: pinStartEnabled, activeSessions: activeSessionCount) : nil
            } else if handle == .agent, !kinds.isEmpty {
                let next = ProviderDialGeometry.softened(initialPosition - dy / 84, count: kinds.count)
                let index = Int(ProviderDialGeometry.clamp(next.rounded(), 0, Double(kinds.count - 1)))
                if index != groupIndex { OrbisHaptics.selectionChanged(); onKind(kinds[index]) }
                groupPosition = ProviderDialGeometry.sticky(next)
            } else if handle == .profile, !providers.isEmpty {
                let next = ProviderDialGeometry.softened(initialPosition - dy / ((g.radius + 28) * g.profileStep * .pi / 180), count: providers.count)
                let index = Int(ProviderDialGeometry.clamp(next.rounded(), 0, Double(providers.count - 1)))
                if index != Int(profilePosition.rounded()) { OrbisHaptics.selectionChanged(); profilePulse += 1 }
                profilePosition = next; onSelect(index)
            }
        }.onEnded { value in
            let captured = handle; handle = nil; gestureStarted = false
            if pinOwner != nil {
                let apply = editable && pinArmed && pinOwner == kind && pinStartChoice == pending && pinStartEnabled == (pending?.target ?? powered)
                // The released pin travels on from where the finger left it, back to rest or on to the Host hold.
                pinOwner = nil; pinArmed = false; hint = nil
                withAnimation(reduced ? nil : .easeOut(duration: 0.22)) { pinDrag = nil }
                if apply { onToggle(!pinStartEnabled) }; return
            }
            if !moved && pinTouched { nudgePin(); return }
            guard let captured else { onMoving(false); return }
            if !moved {
                let angle = atan2(value.startLocation.y - g.centerY, value.startLocation.x - g.centerX) * 180 / .pi
                if captured == .agent { settleAgent(Int(ProviderDialGeometry.clamp((groupPosition + angle / g.agentStep).rounded(), 0, Double(max(0, kinds.count - 1))))) }
                else { settleProfile(Int(ProviderDialGeometry.clamp((profilePosition + angle / g.profileStep).rounded(), 0, Double(max(0, providers.count - 1))))) }
                return
            }
            if captured == .agent { settleAgent(Int(ProviderDialGeometry.clamp(groupPosition.rounded(), 0, Double(max(0, kinds.count - 1))))) }
            else { settleProfile(ProviderDialGeometry.settled(initialPosition, translation: value.translation.height,
                predictedTranslation: value.predictedEndTranslation.height, handle: .profile, count: providers.count, pointsPerStep: (g.radius + 28) * g.profileStep * .pi / 180)) }
        }
    }
    private func resetGesture() {
        guard handle != nil || gestureStarted else { return }
        handle = nil; gestureStarted = false; moved = false; pinOwner = nil; pinDrag = nil; pinArmed = false
        groupPosition = Double(groupIndex); profilePosition = Double(selected); onMoving(false)
    }
    private func keyboardBrowse(_ owner: ProviderDialGeometry.Handle, key: KeyEquivalent) -> KeyPress.Result {
        if key == .leftArrow || key == .rightArrow || key == .space {
            guard owner == .agent, managed, editable else { return .ignored }
            onToggle(key == .rightArrow || (key == .space && !(pending?.target ?? powered))); return .handled
        }
        let count = owner == .agent ? kinds.count : providers.count
        guard count > 0 else { return .handled }
        let current = owner == .agent ? groupIndex : selected
        let next = key == .home ? 0 : key == .end ? count - 1 : max(0, min(count - 1, current + (key == .downArrow ? 1 : -1)))
        if owner == .agent { settleAgent(next) } else { settleProfile(next) }
        return .handled
    }
    private func settleAgent(_ index: Int) {
        guard kinds.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        if kinds[index] != kind { OrbisHaptics.commit(); onKind(kinds[index]) }
        // A docked Agent leaves gently so its pin visibly retracts before the ring turns; a released drag is already moving.
        let departing = abs(groupPosition - groupPosition.rounded()) < 0.01 && Double(index) != groupPosition
        let motion: Animation = departing
            ? .timingCurve(0.65, 0, 0.35, 1, duration: ProviderDialGeometry.settleDuration(distance: Double(index) - groupPosition) + 0.06)
            : InteractionMotion.state
        withAnimation(reduced ? nil : motion) { groupPosition = Double(index) } completion: { onMoving(false) }
    }
    private func settleProfile(_ index: Int) {
        guard providers.indices.contains(index) else { onMoving(false); return }
        onMoving(true)
        let distance = Double(index) - profilePosition
        if Int(profilePosition.rounded()) != index { OrbisHaptics.selectionChanged(); profilePulse += 1 }
        withAnimation(reduced ? nil : InteractionMotion.dialSettle(distance: distance)) { profilePosition = Double(index) } completion: { onSelect(index); onMoving(false) }
    }
    private func adjustAgent(_ direction: AccessibilityAdjustmentDirection) {
        settleAgent(max(0, min(kinds.count - 1, groupIndex + (direction == .increment ? 1 : -1))))
    }
}

/// AGENT-DIAL-04: the Agent ring and the socket it lights. Body is re-evaluated on every animation
/// frame, so a settling ring carries a docked pin along the groove instead of interpolating a chord.
private struct DialAgentRing<Bead: View>: View, Animatable {
    var position: Double
    var travel: Double
    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(position, travel) }
        set { position = newValue.first; travel = newValue.second }
    }
    let g: ProviderDialGeometry.Layout
    let kinds: [String]
    let kind: String
    let managed: Bool
    let dimmed: Bool
    let rests: [String: Double]
    let palette: OrbisPalette
    let conflict: Bool
    let recoil: Double
    let offline: Bool
    let enabled: (String) -> Bool
    let onTap: (Int) -> Void
    @ViewBuilder let bead: (String, Double) -> Bead
    var body: some View {
        ZStack {
            if managed && !kind.isEmpty { socket }
            ForEach(Array(kinds.enumerated()), id: \.element) { index, agent in
                let distance = Double(index) - position
                let selected = agent == kind
                let centre = g.pinCentre(distance: distance, travel: managed ? (selected ? travel : rests[agent] ?? 0) : 0)
                let gate = ProviderDialGeometry.gate(distance)
                if abs(distance) < 3.1 && centre.x >= 20 {
                    ZStack {
                        // The raised cap belongs to whichever Agent is docking, rising and sinking with ring position.
                        if managed && gate > 0.01 {
                            Circle().fill(.clear).neuSurface(radius: 20, intensity: enabled(agent) ? 0.6 : 0.28, concentric: false)
                                .environment(\.orbisSurface, nil).frame(width: 40, height: 40).opacity(gate)
                        }
                        bead(agent, gate)
                    }.frame(width: 44, height: 44).contentShape(Rectangle())
                        .opacity((0.66 + 0.34 * gate) * (dimmed ? 0.4 + 0.6 * ProviderDialGeometry.docked(distance) : 1))
                        .position(x: centre.x + (selected ? recoil : 0), y: centre.y)
                        .onTapGesture { onTap(index) }
                        // A tap on the managed pin belongs to the dial gesture, which answers with the pin hint.
                        .allowsHitTesting(!(managed && selected))
                }
            }
        }
    }
    private var socket: some View {
        var lit = 0.0, nearest = Double.infinity, gateKind = kind
        for (index, agent) in kinds.enumerated() {
            let distance = abs(Double(index) - position)
            if distance < nearest { nearest = distance; gateKind = agent }
            if enabled(agent) && !offline { lit += ProviderDialGeometry.seated(distance) }
        }
        lit = min(1, lit)
        return ZStack {
            if conflict { Circle().strokeBorder(palette.error.opacity(0.75), lineWidth: 1.5) }
            else {
                Circle().strokeBorder(palette.faint.opacity(0.50), lineWidth: 1 + 0.5 * lit).opacity(1 - lit)
                Circle().strokeBorder(palette.agent(gateKind).opacity(0.85), lineWidth: 1 + 0.5 * lit).opacity(lit)
            }
        }.frame(width: 36, height: 36).position(x: g.pinStart + g.pinTravel, y: g.centerY).allowsHitTesting(false)
    }
}


struct StatusSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
                .padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .neuSurface(radius: OrbisRadius.card)
        }
    }
}

struct StatusFact: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let label: String
    /// A short qualifier shown beside the label in its own color, instead of joining them with a dot.
    var tag: String? = nil
    let value: String
    var tone: Color? = nil
    var monospaced = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(label).foregroundStyle(OrbisPalette(scheme).secondary)
                if let tag { Text(tag).fontWeight(.semibold).foregroundStyle(OrbisPalette(scheme).text) }
            }.font(.orbisCaption())
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if let tone { Circle().fill(tone).frame(width: 7, height: 7).orbisIconBaseline(OrbisTextSize.body) }
                Text(value).font(.orbisBody(mono: monospaced))
                    .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One fact on a line: label on the left, value (with its state color) on the right, as on Android.
struct StatusRow: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let label: String
    let value: String
    var tone: Color? = nil
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                Text(label).font(.orbisBody()).fixedSize()
                Spacer(minLength: 0)
                valueBadge.fixedSize()
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(label).font(.orbisBody()).fixedSize(horizontal: false, vertical: true)
                valueBadge
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var valueBadge: some View {
        HStack(spacing: 6) {
            if let tone { Circle().fill(tone).frame(width: 7, height: 7) }
            Text(value).font(.orbisLabel(.medium)).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(tone ?? OrbisPalette(scheme).text).textSelection(.enabled)
        }.padding(.horizontal, tone == nil ? 0 : 10).frame(minHeight: 30)
            .background { if tone != nil { Capsule().fill(OrbisPalette(scheme).well) } }
    }
}

func pathTitle(_ path: String?) -> String {
    switch path { case "lan": return L10n.tr("局域网"); case "relay": return L10n.tr("中继"); default: return L10n.tr("尚未确认") }
}


private struct OrbisDialSweep: View, Animatable {
    var progress: Double
    let tint: Color
    let geometry: ProviderDialGeometry.Layout
    var animatableData: Double { get { progress } set { progress = newValue } }
    var body: some View {
        Path { path in
            for direction in [-1.0, 1.0] {
                path.move(to: CGPoint(x: geometry.centerX + geometry.radius - 12, y: geometry.centerY))
                path.addArc(center: CGPoint(x: geometry.centerX, y: geometry.centerY), radius: geometry.radius - 12,
                            startAngle: .degrees(0), endAngle: .degrees(direction * 110 * progress), clockwise: direction < 0)
            }
        }.stroke(tint.opacity(max(0, sin(progress * .pi)) * 0.7), lineWidth: 2)
    }
}

/// UIKeyCommand reaches physical keyboards consistently on iOS 17+ even when
/// SwiftUI's decorative dial circles do not become native first responders.
private struct OrbisDialKeyboardBridge: UIViewRepresentable {
    let active: Bool
    let pinEditable: Bool
    @Binding var focus: ProviderDialGeometry.Handle?
    let browse: (ProviderDialGeometry.Handle, KeyEquivalent) -> Void
    func makeUIView(context: Context) -> Receiver { Receiver() }
    func updateUIView(_ view: Receiver, context: Context) {
        view.active = active; view.owner = focus; view.browse = browse; view.pinEditable = pinEditable
        view.changeFocus = { focus = $0 }
        if active && focus != nil { if !view.isFirstResponder { view.becomeFirstResponder() } }
        else if view.isFirstResponder { view.resignFirstResponder() }
    }
    final class Receiver: UIView {
        var owner: ProviderDialGeometry.Handle?
        var active = false
        var pinEditable = false
        var acceptsPinKeys: Bool { owner == .agent && pinEditable }
        override func didMoveToWindow() { super.didMoveToWindow(); if window != nil && active && owner != nil { becomeFirstResponder() } }
        var browse: (ProviderDialGeometry.Handle, KeyEquivalent) -> Void = { _, _ in }
        var changeFocus: (ProviderDialGeometry.Handle?) -> Void = { _ in }
        override var canBecomeFirstResponder: Bool { true }
        override var canBecomeFocused: Bool { active }
        override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
            super.didUpdateFocus(in: context, with: coordinator)
            if context.nextFocusedView === self { if owner == nil { owner = .profile; changeFocus(.profile) }; becomeFirstResponder() }
        }
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard let key = presses.compactMap(\.key).first(where: { $0.keyCode != .keyboardLeftShift && $0.keyCode != .keyboardRightShift }), owner != nil else { super.pressesBegan(presses, with: event); return }
            switch key.keyCode {
            case .keyboardUpArrow: up()
            case .keyboardDownArrow: down()
            case .keyboardHome: home()
            case .keyboardEnd: end()
            case .keyboardLeftArrow where acceptsPinKeys: left()
            case .keyboardRightArrow where acceptsPinKeys: right()
            case .keyboardSpacebar where acceptsPinKeys: space()
            case .keyboardTab:
                let shift = key.modifierFlags.contains(.shift) || presses.compactMap(\.key).contains { [.keyboardLeftShift, .keyboardRightShift].contains($0.keyCode) }
                if shift, owner == .agent { previous() }
                else if !shift, owner == .profile { nextHandle() }
                else { super.pressesBegan(presses, with: event) }
            default: super.pressesBegan(presses, with: event)
            }
        }
        override var keyCommands: [UIKeyCommand]? {
            var commands = [UIKeyCommand(input: UIKeyCommand.inputUpArrow, modifierFlags: [], action: #selector(up)),
             UIKeyCommand(input: UIKeyCommand.inputDownArrow, modifierFlags: [], action: #selector(down)),
             UIKeyCommand(input: UIKeyCommand.inputHome, modifierFlags: [], action: #selector(home)),
             UIKeyCommand(input: UIKeyCommand.inputEnd, modifierFlags: [], action: #selector(end))]
            if acceptsPinKeys {
                commands += [UIKeyCommand(input: UIKeyCommand.inputLeftArrow, modifierFlags: [], action: #selector(left)),
                             UIKeyCommand(input: UIKeyCommand.inputRightArrow, modifierFlags: [], action: #selector(right)),
                             UIKeyCommand(input: " ", modifierFlags: [], action: #selector(space))]
            }
            if owner == .profile { commands.append(UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(nextHandle))) }
            if owner == .agent { commands.append(UIKeyCommand(input: "\t", modifierFlags: .shift, action: #selector(previous))) }
            return commands.map { command in
                command.wantsPriorityOverSystemBehavior = true; return command
             }
        }
        @objc private func up() { if let owner { browse(owner, .upArrow) } }
        @objc private func down() { if let owner { browse(owner, .downArrow) } }
        @objc private func home() { if let owner { browse(owner, .home) } }
        @objc private func left() { if let owner { browse(owner, .leftArrow) } }
        @objc private func right() { if let owner { browse(owner, .rightArrow) } }
        @objc private func space() { if let owner { browse(owner, .space) } }
        @objc private func end() {
            if let owner { browse(owner, .end) }
        }
        @objc private func nextHandle() {
            if owner == .profile { owner = .agent; changeFocus(.agent) }
            else { owner = nil; changeFocus(nil); resignFirstResponder() }
        }
        @objc private func previous() {
            if owner == .agent { owner = .profile; changeFocus(.profile) }
            else { owner = nil; changeFocus(nil); resignFirstResponder() }
        }
    }
}
