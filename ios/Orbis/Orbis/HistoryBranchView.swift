import SwiftUI

private struct HistoryOptionsKey: Equatable {
    let target: ChatActionContext
    let catalog: String?
}

struct HistoryBranchView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let onBack: () -> Void
    /// Same download entry as the chat header; the downloads page returns here (ADR-0054, §7).
    let onDownloads: () -> Void
    @State private var query = ""
    @State private var selected: RuntimeOption?
    @State private var previewHandle: EntryPreviewHandle?
    @State private var previewTarget: ChatActionContext?
    @State private var menuTarget: ChatActionContext?
    @State private var showOtherBranches = false
    @State private var showDetails = false
    @State private var actionPending = false
    @StateObject private var downloadFlight = DownloadFlight()
    /// The downloads page covers this one and returns here: keep the preview and the scroll position.
    @State private var openingDownloads = false
    @State private var scrolledToCurrent = false
    @FocusState private var searchFocused: Bool

    private var ownedPreview: EntryPreview? {
        guard let previewHandle, previewHandle.owner.ownsEntryPreview(previewHandle) else { return nil }
        return previewHandle.owner.entryPreview
    }

    private var options: [RuntimeOption] {
        guard let id = store.selectedRuntimeId else { return [] }
        return store.isViewingCachedSession ? store.cachedHistoryOptions : store.commands[id]?.first { $0.name == "tree" }?.argument?.options ?? store.cachedHistoryOptions
    }
    private var optionCatalog: MenuOptionCatalog? {
        guard let id = store.selectedRuntimeId else { return nil }
        return store.commands[id]?.first { $0.name == "tree" }?.argument?.optionCatalog
    }
    private var visible: [RuntimeOption] {
        options.filter { option in
            let tree = option.tree
            return (showOtherBranches || tree?.isOnActivePath != false || tree?.isCurrent == true) &&
                (showDetails || tree?.defaultHidden != true || tree?.isCurrent == true) &&
                (query.isEmpty || option.label.localizedCaseInsensitiveContains(query) || option.description?.localizedCaseInsensitiveContains(query) == true)
        }
    }

    var body: some View {
        let target = ChatActionContext.capture(store)
        VStack(spacing: 12) {
            OrbisPageHeader(title: L10n.tr("历史与分支"), titleLineLimit: 2, back: onBack) {
                OrbisMenuIconButton(symbol: "line.3.horizontal.decrease", label: L10n.tr("筛选历史"),
                                    tint: showOtherBranches || showDetails ? OrbisPalette(scheme).accent : nil,
                                    selected: showOtherBranches || showDetails) {
                    [OrbisMenuItem(title: L10n.tr("显示其他分支"), symbol: "arrow.triangle.branch", checked: showOtherBranches) { showOtherBranches.toggle() },
                     OrbisMenuItem(title: L10n.tr("显示工具与细节"), symbol: "wrench.and.screwdriver", checked: showDetails) { showDetails.toggle() }]
                }
                OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载")) { openingDownloads = true; onDownloads() }
                    .downloadFlightTarget(downloadFlight).accessibilityIdentifier("history-downloads")
            }
            HStack(spacing: 10) {
                OrbisActionSymbol(systemName: "magnifyingglass").foregroundStyle(OrbisPalette(scheme).secondary)
                TextField(L10n.tr("搜索历史与分支"), text: $query).autocorrectionDisabled().font(.orbisBody()).textInputAutocapitalization(.never)
                    .focused($searchFocused)
                OrbisIconButton(symbol: "xmark", label: L10n.tr("清除搜索"), size: 28) { query = "" }
                    .opacity(query.isEmpty ? 0 : 1).disabled(query.isEmpty).accessibilityHidden(query.isEmpty)
            }.padding(.leading, 14).padding(.trailing, 6).frame(minHeight: 56).orbisField(focused: searchFocused).padding(.horizontal, 20)
            if store.isViewingCachedSession { OrbisStatusWithInfo(title: L10n.tr("本机缓存"), message: L10n.tr("当前显示本机缓存。浏览节点和分支不会改变电脑端会话。")).padding(.horizontal, 20) }
            if options.isEmpty && (optionCatalog?.count ?? 0) > 0 {
                ProgressView(L10n.tr("读取中…")).padding(24)
                OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") {
                    if target.matches(store), let id = target.runtimeId { target.owner.loadMenuOptions(runtimeId: id, name: "tree") }
                }.padding(.horizontal, 24)
            } else if options.isEmpty {
                OrbisEmptyState(symbol: "clock.arrow.circlepath", title: L10n.tr("当前会话尚未提供历史分支"))
                OrbisActionButton(title: L10n.tr("刷新会话"), symbol: "arrow.clockwise") {
                    if target.matches(store) { target.owner.refresh() }
                }.padding(.horizontal, 24).padding(.bottom, 24).disabled(!store.canSend)
            } else {
                ScrollViewReader { proxy in
                    HStack {
                        Text(L10n.tr("{0} 条记录", visible.count)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Spacer()
                        OrbisTextButton(title: L10n.tr("回到当前位置"), symbol: "scope") {
                            query = ""
                            if let current = options.first(where: { $0.tree?.isCurrent == true }) { proxy.scrollTo(current.value, anchor: .center) }
                        }
                    }.padding(.horizontal, 24)
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(visible) { option in
                                node(option).id(option.value)
                            }
                            let others = options.filter { $0.tree?.isOnActivePath == false }.count
                            if !showOtherBranches && others > 0 && query.isEmpty {
                                OrbisActionButton(title: L10n.tr("其他分支（{0} 条记录）", others), symbol: "chevron.right") { showOtherBranches = true }
                            }
                        }.padding(.horizontal, 24).padding(.vertical, 10)
                    }.scrollDismissesKeyboard(.interactively)
                        .onAppear {
                            guard !scrolledToCurrent else { return }
                            scrolledToCurrent = true
                            if let current = options.first(where: { $0.tree?.isCurrent == true }) { proxy.scrollTo(current.value, anchor: .center) }
                        }
                }
            }
            if let selected { preview(selected) }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .downloadFlightHost(downloadFlight)
            .onChange(of: store.historyRevision) { _, _ in onBack() }
            .onChange(of: store.pendingActionIds) { _, ids in if ids.isEmpty { actionPending = false } }
            .onAppear { openingDownloads = false }
            .task(id: HistoryOptionsKey(target: target, catalog: optionCatalog?.id)) {
                if let old = menuTarget, old != target, old.ownsRuntime, let id = old.runtimeId {
                    old.owner.cancelMenuOptions(runtimeId: id, name: "tree")
                }
                menuTarget = target
                if target.matches(store), let id = target.runtimeId { target.owner.loadMenuOptions(runtimeId: id, name: "tree") }
            }
            .onChange(of: target) { _, _ in dismissOwnedPreview(); selected = nil }
            .onDisappear {
                if let target = menuTarget, target.ownsRuntime, let id = target.runtimeId { target.owner.cancelMenuOptions(runtimeId: id, name: "tree") }
                if !openingDownloads { dismissOwnedPreview() }
            }
    }

    private func node(_ option: RuntimeOption) -> some View {
        let target = ChatActionContext.capture(store)
        return OrbisMotionButton {
            guard target.matches(store), let handle = target.owner.previewEntry(option.value) else { return }
            selected = option; previewTarget = target; previewHandle = handle
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(role(option)).fontWeight(.semibold)
                    if option.tree?.isCurrent == true { Text(L10n.tr("当前位置")) }
                    if selected?.value == option.value { Text(L10n.tr("正在预览")) }
                    Spacer()
                }.font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).accent)
                Text(option.label).font(.orbisBody()).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(14).frame(minHeight: 64)
        }.buttonStyle(NeuButtonStyle(selected: selected?.value == option.value || option.tree?.isCurrent == true))
            .disabled((!store.canSend && !store.isViewingCachedSession) || actionPending)
            .padding(.leading, option.tree?.isOnActivePath == false ? 16 : 0)
    }

    private func preview(_ option: RuntimeOption) -> some View {
        let handle = previewHandle, target = previewTarget, displayed = ownedPreview
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n.tr("正在预览")).font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).accent)
                Spacer()
                OrbisIconButton(symbol: "xmark", label: L10n.tr("退出预览"), size: 32) {
                    if previewHandle == handle { selected = nil; dismissOwnedPreview() }
                }
            }
            ScrollView {
                if displayed?.loading == true { ProgressView(L10n.tr("读取中…")).font(.orbisCaption()).padding(20) }
                else if let message = displayed?.message {
                    ChatMessageRow(row: ChatRow(messages: [message]), kind: store.selectedRuntime.flatMap { store.agentKind($0) },
                                   readContext: target.map { ChatReadContext(store: store, target: $0, canRead: $0.owner.canSend) })
                } else {
                    Text(displayed?.error ?? L10n.tr("该节点没有可预览的消息内容。")).font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).padding(12)
                    if displayed?.error != nil {
                        OrbisActionButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { retryOwnedPreview(expected: handle, target: target) }
                            .accessibilityIdentifier("history-preview-retry")
                    }
                }
            }.frame(maxHeight: 160)
            if store.isViewingCachedSession {
                OrbisActionButton(title: L10n.tr("查看这个分支的缓存"), symbol: "arrow.triangle.branch") {
                    guard previewHandle == handle, target?.matches(store) == true else { return }
                    store.selectCachedBranch(option.value); selected = nil; dismissOwnedPreview()
                }.disabled(displayed?.loading == true)
            } else if ["user", "assistant"].contains(option.tree?.role ?? "") {
                // The pending state lives in the button's own title, so the panel never grows.
                OrbisActionButton(title: actionPending ? L10n.tr("正在切换分支…") : option.tree?.role == "user" ? L10n.tr("编辑这条消息并重新开始") : L10n.tr("从这条回复后继续"),
                                  symbol: "arrow.turn.down.right") {
                    guard previewHandle == handle, target?.matches(store) == true else { return }
                    actionPending = store.moveHistory(to: option)
                    if actionPending { OrbisHaptics.commit() }
                }.disabled(actionPending || !store.canSend || !store.pendingActionIds.isEmpty || displayed?.loading == true)
            }
        }.neuSurface(radius: OrbisRadius.card, padding: 12).padding(.horizontal, 20).padding(.bottom, 12)
    }
    private func dismissOwnedPreview() {
        if let previewHandle { previewHandle.owner.dismissPreview(expected: previewHandle) }
        previewHandle = nil; previewTarget = nil
    }
    private func retryOwnedPreview(expected: EntryPreviewHandle?, target: ChatActionContext?) {
        guard let expected, previewHandle == expected, target?.matches(store) == true,
              let next = expected.owner.retryPreview(expected: expected) else { return }
        self.previewHandle = next
    }
    private func role(_ option: RuntimeOption) -> String {
        switch option.tree?.role { case "user": return L10n.tr("你的消息"); case "assistant": return L10n.tr("助手回复"); case "toolResult", "tool": return L10n.tr("工具"); default: return L10n.tr("记录") }
    }
}
