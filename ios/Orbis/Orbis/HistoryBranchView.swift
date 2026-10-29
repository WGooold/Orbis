import SwiftUI

struct HistoryBranchView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    @State private var query = ""
    @State private var selected: RuntimeOption?
    @State private var showOtherBranches = false
    @State private var showDetails = false
    @State private var actionPending = false
    @FocusState private var searchFocused: Bool

    private var options: [RuntimeOption] {
        guard let id = store.selectedRuntimeId else { return [] }
        return store.isViewingCachedSession ? store.cachedHistoryOptions : store.commands[id]?.first { $0.name == "tree" }?.argument?.options ?? store.cachedHistoryOptions
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
        VStack(spacing: 12) {
            OrbisPageHeader(title: "历史与分支", back: onBack) {
                OrbisMenuIconButton(symbol: "line.3.horizontal.decrease", label: "筛选历史",
                                    tint: showOtherBranches || showDetails ? OrbisPalette(scheme).accent : nil,
                                    selected: showOtherBranches || showDetails) {
                    [OrbisMenuItem(title: "显示其他分支", symbol: "arrow.triangle.branch", checked: showOtherBranches) { showOtherBranches.toggle() },
                     OrbisMenuItem(title: "显示工具与细节", symbol: "wrench.and.screwdriver", checked: showDetails) { showDetails.toggle() }]
                }
            }
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(OrbisPalette(scheme).secondary)
                TextField("搜索历史与分支", text: $query).autocorrectionDisabled().font(.orbisBody()).textInputAutocapitalization(.never)
                    .focused($searchFocused)
                OrbisIconButton(symbol: "xmark", label: "清除搜索", size: 28) { query = "" }
                    .opacity(query.isEmpty ? 0 : 1).disabled(query.isEmpty).accessibilityHidden(query.isEmpty)
            }.padding(.leading, 14).padding(.trailing, 6).frame(minHeight: 56).orbisField(focused: searchFocused).padding(.horizontal, 20)
            if store.isViewingCachedSession { OrbisNotice(text: "当前显示本机缓存。浏览节点和分支不会改变电脑端会话。").padding(.horizontal, 20) }
            if options.isEmpty {
                OrbisEmptyState(symbol: "clock.arrow.circlepath", title: "当前会话尚未提供历史分支")
                OrbisActionButton(title: "刷新会话", symbol: "arrow.clockwise", action: store.refresh).padding(.horizontal, 24).padding(.bottom, 24).disabled(!store.canSend)
            } else {
                ScrollViewReader { proxy in
                    HStack {
                        Text("\(visible.count) 条记录").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        Spacer()
                        OrbisTextButton(title: "回到当前位置", symbol: "scope") {
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
                                OrbisActionButton(title: "其他分支（\(others) 条记录）", symbol: "chevron.right") { showOtherBranches = true }
                            }
                        }.padding(.horizontal, 24).padding(.vertical, 10)
                    }.scrollDismissesKeyboard(.interactively)
                        .onAppear { if let current = options.first(where: { $0.tree?.isCurrent == true }) { proxy.scrollTo(current.value, anchor: .center) } }
                }
            }
            if let selected { preview(selected) }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onChange(of: store.historyRevision) { _, _ in onBack() }
            .onChange(of: store.pendingActionIds) { _, ids in if ids.isEmpty { actionPending = false } }
            .onDisappear { store.dismissPreview() }
    }

    private func node(_ option: RuntimeOption) -> some View {
        Button { selected = option; store.previewEntry(option.value) } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(role(option)).fontWeight(.semibold)
                    if option.tree?.isCurrent == true { Text("当前位置") }
                    if selected?.value == option.value { Text("正在预览") }
                    Spacer()
                }.font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).accent)
                Text(option.label).font(.orbisBody()).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(14).frame(minHeight: 64)
        }.buttonStyle(NeuButtonStyle(selected: selected?.value == option.value || option.tree?.isCurrent == true))
            .disabled((!store.canSend && !store.isViewingCachedSession) || actionPending)
            .padding(.leading, option.tree?.isOnActivePath == false ? 16 : 0)
    }

    private func preview(_ option: RuntimeOption) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("正在预览").font(.orbisLabel(.semibold)).foregroundStyle(OrbisPalette(scheme).accent)
                Spacer()
                OrbisIconButton(symbol: "xmark", label: "退出预览", size: 32) { selected = nil; store.dismissPreview() }
            }
            ScrollView {
                if store.entryPreview?.loading == true { ProgressView("读取中…").font(.orbisCaption()).padding(20) }
                else if let message = store.entryPreview?.message {
                    ChatMessageRow(row: ChatRow(messages: [message]), kind: store.selectedRuntime.flatMap { store.agentKind($0) })
                } else { Text(store.entryPreview?.error ?? "该节点没有可预览的消息内容。").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).padding(12) }
            }.frame(maxHeight: 160)
            if store.isViewingCachedSession {
                OrbisActionButton(title: "查看这个分支的缓存", symbol: "arrow.triangle.branch") { store.selectCachedBranch(option.value); selected = nil; store.dismissPreview() }
                    .disabled(store.entryPreview?.loading == true)
            } else if ["user", "assistant"].contains(option.tree?.role ?? "") {
                // The pending state lives in the button's own title, so the panel never grows.
                OrbisActionButton(title: actionPending ? "正在切换分支…" : option.tree?.role == "user" ? "编辑这条消息并重新开始" : "从这条回复后继续",
                                  symbol: "arrow.turn.down.right") {
                    actionPending = store.moveHistory(to: option)
                    if actionPending { OrbisHaptics.commit() }
                }.disabled(actionPending || !store.canSend || !store.pendingActionIds.isEmpty || store.entryPreview?.loading == true)
            }
        }.neuSurface(radius: OrbisRadius.card, padding: 12).padding(.horizontal, 20).padding(.bottom, 12)
    }
    private func role(_ option: RuntimeOption) -> String {
        switch option.tree?.role { case "user": return "你的消息"; case "assistant": return "助手回复"; case "toolResult", "tool": return "工具"; default: return "记录" }
    }
}
