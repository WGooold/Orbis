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

    private var options: [RuntimeOption] {
        guard let id = store.selectedRuntimeId else { return [] }
        return store.commands[id]?.first { $0.name == "tree" }?.argument?.options ?? []
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
                Menu {
                    Toggle("显示其他分支", isOn: $showOtherBranches)
                    Toggle("显示工具与细节", isOn: $showDetails)
                } label: { Image(systemName: "line.3.horizontal.decrease").frame(width: 40, height: 40).neuSurface(radius: 20, intensity: 0.5).frame(width: 48, height: 48) }
                    .accessibilityLabel("筛选历史")
            }
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                TextField("搜索历史与分支", text: $query).autocorrectionDisabled().font(.system(size: 14)).textInputAutocapitalization(.never)
                if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 32, height: 32) }.accessibilityLabel("清除搜索") }
            }.padding(.horizontal, 14).frame(minHeight: 56).neuSurface(inset: true, radius: 16, intensity: 0.6).padding(.horizontal, 20)
            if options.isEmpty {
                OrbisEmptyState(symbol: "clock.arrow.circlepath", title: "当前会话尚未提供历史分支", detail: "连接电脑并刷新会话后重试。")
                OrbisActionButton(title: "刷新会话", symbol: "arrow.clockwise", action: store.refresh).padding(.horizontal, 24).padding(.bottom, 24).disabled(!store.canSend)
            } else {
                ScrollViewReader { proxy in
                    HStack {
                        Text("\(visible.count) 条记录").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                        Spacer()
                        Button("回到当前位置") {
                            query = ""
                            if let current = options.first(where: { $0.tree?.isCurrent == true }) { proxy.scrollTo(current.value, anchor: .center) }
                        }.font(.system(size: 12, weight: .semibold)).frame(minHeight: 40)
                    }.padding(.horizontal, 24)
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(visible) { option in
                                node(option).id(option.value)
                            }
                            let others = options.filter { $0.tree?.isOnActivePath == false }.count
                            if !showOtherBranches && others > 0 && query.isEmpty {
                                OrbisActionButton(title: "其他分支 · \(others) 条记录", symbol: "chevron.right") { showOtherBranches = true }
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
                    Text(role(option)).font(.system(size: 11, weight: .semibold))
                    if option.tree?.isCurrent == true { Text("当前位置").font(.system(size: 11)) }
                    if selected?.value == option.value { Text("正在预览").font(.system(size: 11)) }
                    Spacer()
                }.foregroundStyle(OrbisPalette(scheme).accent)
                Text(option.label).font(.system(size: 14)).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(14).frame(minHeight: 64)
        }.buttonStyle(NeuButtonStyle(selected: selected?.value == option.value || option.tree?.isCurrent == true))
            .disabled(!store.canSend || actionPending)
            .padding(.leading, option.tree?.isOnActivePath == false ? 16 : 0)
    }

    private func preview(_ option: RuntimeOption) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("正在预览").font(.system(size: 13, weight: .semibold)).foregroundStyle(OrbisPalette(scheme).accent)
                Text("不会改变电脑端会话").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
                Spacer()
                Button { selected = nil; store.dismissPreview() } label: { Image(systemName: "xmark").frame(width: 36, height: 36) }.accessibilityLabel("退出预览")
            }
            ScrollView {
                if store.entryPreview?.loading == true { ProgressView("读取中…").padding(20) }
                else if let message = store.entryPreview?.message {
                    ChatMessageRow(row: ChatRow(messages: [message]), kind: store.selectedRuntime?.agentKind)
                } else { Text(store.entryPreview?.error ?? "该节点没有可预览的消息内容。").font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary).padding(12) }
            }.frame(maxHeight: 160)
            if ["user", "assistant"].contains(option.tree?.role ?? "") {
                OrbisActionButton(title: option.tree?.role == "user" ? "编辑这条消息并重新开始" : "从这条回复后继续", symbol: "arrow.turn.down.right") {
                    actionPending = store.moveHistory(to: option)
                }.disabled(!store.canSend || !store.pendingActionIds.isEmpty || store.entryPreview?.loading == true)
                if actionPending { ProgressView("正在切换分支…").font(.system(size: 12)) }
            }
        }.padding(16).neuSurface(radius: 20).padding(.horizontal, 20).padding(.bottom, 12)
    }
    private func role(_ option: RuntimeOption) -> String {
        switch option.tree?.role { case "user": return "你的消息"; case "assistant": return "助手回复"; case "toolResult", "tool": return "工具"; default: return "记录" }
    }
}
