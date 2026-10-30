import SwiftUI

struct DownloadsView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    @State private var browserOpen = false
    @State private var selected: Set<String> = []
    @State private var path = ""
    @FocusState private var pathFocused: Bool
    private var downloads: [FileTransfer] { transfers.currentTasks.filter { $0.direction == "download" } }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: selected.isEmpty ? "下载" : "已选择 \(selected.count) 项", closes: !selected.isEmpty, backLabel: selected.isEmpty ? "返回" : "退出多选", back: { if selected.isEmpty { onBack() } else { selected = [] } }) {
                if !selected.isEmpty {
                    OrbisIconButton(symbol: "trash", label: "删除所选下载", tint: OrbisPalette(scheme).error, action: confirmDelete)
                }
            }
            HStack(spacing: 10) {
                TextField("电脑文件的完整路径", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.orbisBody()).focused($pathFocused).orbisInput(focused: pathFocused).accessibilityIdentifier("download-path")
                OrbisIconButton(symbol: "arrow.down.to.line", label: "按路径下载") { transfers.download(path: path.trimmingCharacters(in: .whitespacesAndNewlines)); path = "" }
                    .disabled(store.connection != .secured || path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(.horizontal, 24).padding(.top, 8)
            OrbisActionButton(title: "浏览电脑文件", symbol: "folder") { browserOpen = true }
                .disabled(store.connection != .secured).padding(.horizontal, 24).padding(.vertical, 12)
            if downloads.isEmpty { OrbisEmptyState(symbol: "arrow.down.to.line", title: "暂无下载") }
            else {
                ScrollView {
                    LazyVStack(spacing: 18) {
                        ForEach(downloads) { task in
                            transferCard(task)
                        }
                    }.padding(24)
                }
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onChange(of: store.selectedHostId) { _, _ in selected = [] }
            .onChange(of: downloads.map(\.id)) { _, ids in selected.formIntersection(ids) }
            .sheet(isPresented: $browserOpen, onDismiss: store.dismissBrowse) {
                DownloadBrowserView { browserOpen = false }.orbisSheet([.large])
            }
    }

    private func beginSelection(_ id: String) {
        if selected.isEmpty { OrbisHaptics.beginSelection() }
        selected.insert(id)
    }

    private func confirmDelete() {
        let ids = selected
        overlay.showDialog("删除下载记录与本机文件？", message: "电脑上的原文件不受影响。", actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "删除 \(ids.count) 项", role: .destructive) { transfers.remove(ids); selected = [] }
        ])
    }

    @ViewBuilder
    private func transferCard(_ task: FileTransfer) -> some View {
        Group {
            if selected.isEmpty, task.status == "completed", let path = task.localPath {
                ShareLink(item: URL(fileURLWithPath: path)) { transferCardContent(task) }
            } else {
                Button {
                    if !selected.isEmpty {
                        if !selected.insert(task.id).inserted { selected.remove(task.id) }
                    } else if ["queued", "downloading", "verifying"].contains(task.status) {
                        // Cancellation preserves the partial file and prevents automatic resumption.
                        transfers.cancel(task.id)
                    } else if task.status != "completed", store.connection == .secured {
                        transfers.restart(task.id)
                    }
                } label: { transferCardContent(task) }
            }
        }
        .buttonStyle(OrbisSelectionButtonStyle(selected: selected.contains(task.id), selecting: !selected.isEmpty))
        .highPriorityGesture(LongPressGesture().onEnded { _ in beginSelection(task.id) })
        .accessibilityIdentifier("download-card-\(task.id)")
        .accessibilityHint(selected.isEmpty ? "长按进入多选" : "轻点切换选择")
        .accessibilityAddTraits(selected.contains(task.id) ? .isSelected : [])
        .accessibilityAction(named: "选择下载") { beginSelection(task.id) }
    }

    private func transferCardContent(_ task: FileTransfer) -> some View {
        let p = OrbisPalette(scheme)
        let failed = task.status == "failed"
        let active = ["queued", "downloading", "verifying"].contains(task.status)
        let stopped = ["paused", "cancelled"].contains(task.status)
        let actionHint: String = {
            if !selected.isEmpty { return selected.contains(task.id) ? "已选择" : "轻点选择" }
            if active { return "轻点暂停" }
            if task.status == "completed" { return task.localPath == nil ? "" : "轻点分享" }
            if store.connection != .secured { return "连接电脑后继续" }
            return failed ? "轻点重试" : "轻点继续"
        }()
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "doc")
                    .font(.system(size: 22)).foregroundStyle(p.accent)
                    .frame(width: 44, height: 44).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    FileNameText(name: task.name).font(.orbisBody(.semibold)).foregroundStyle(p.text)
                    Text(task.status == "cancelled" ? "已暂停" : task.error ?? transferStatusTitle(task.status))
                        .font(.orbisCaption()).foregroundStyle(failed ? p.error : p.secondary).lineLimit(2)
                }.frame(maxWidth: .infinity, alignment: .leading)
                OrbisSelectionIndicator(selected: selected.contains(task.id), selecting: !selected.isEmpty)
            }
            VStack(spacing: 8) {
                ProgressView(value: min(Double(max(task.size, 1)), Double(task.received)), total: Double(max(task.size, 1)))
                    .tint(failed ? p.error : task.status == "completed" ? p.success : stopped ? p.secondary : p.accent)
                    .accessibilityHidden(true)
                HStack(spacing: 8) {
                    Text("\(byteCount(task.received)) / \(byteCount(task.size))")
                    Spacer(minLength: 0)
                    Text(actionHint).lineLimit(1)
                }
                .font(.orbisCaption()).foregroundStyle(p.secondary)
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct DownloadBrowserView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @Environment(\.colorScheme) private var scheme
    let onDismiss: () -> Void
    @State private var selected: BrowseEntry?
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: "浏览电脑文件", closes: true, back: onDismiss) { EmptyView() }
            ScrollView {
                VStack(spacing: 14) {
                    HStack {
                        Text(store.browse?.path.flatMap { $0.isEmpty ? nil : $0 } ?? "电脑根目录").font(.orbisCaption(mono: true)).frame(maxWidth: .infinity, alignment: .leading)
                        ZStack {
                            if store.browse?.loading == true { ProgressView().controlSize(.small) }
                            else { OrbisIconButton(symbol: "arrow.clockwise", label: "刷新目录") { store.browseDirectory(store.browse?.path) } }
                        }.frame(width: 48, height: 48)
                    }
                    if store.browse?.path?.isEmpty == false {
                        OrbisActionButton(title: "上一级", symbol: "arrow.up") { selected = nil; store.browseDirectory(store.browse?.parent) }.disabled(store.browse?.loading == true)
                    }
                    if let error = store.browse?.error {
                        OrbisNotice(text: error, error: true)
                        OrbisActionButton(title: "重新读取", symbol: "arrow.clockwise") { store.browseDirectory(store.browse?.path) }
                    } else if store.browse?.loading == false {
                        ForEach((store.browse?.entries ?? []).sorted { ($0.isDir ? 0 : 1, $0.name) < ($1.isDir ? 0 : 1, $1.name) }) { entry in
                            Button {
                                if entry.isDir { selected = nil; store.browseDirectory(remoteBrowsePath(parent: store.browse?.path, name: entry.name)) }
                                else { selected = entry }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: entry.isDir ? "folder" : "doc").foregroundStyle(OrbisPalette(scheme).accent)
                                    Group {
                                        if entry.isDir { Text(entry.name).lineLimit(1) } else { FileNameText(name: entry.name) }
                                    }.font(.orbisBody()).frame(maxWidth: .infinity, alignment: .leading)
                                    // Files reserve the check slot, so selecting one never shifts its name.
                                    if entry.isDir { Image(systemName: "chevron.right").imageScale(.small) }
                                    else { Image(systemName: "checkmark.circle.fill").opacity(selected?.id == entry.id ? 1 : 0) }
                                }.padding(14).frame(minHeight: 52)
                            }.buttonStyle(NeuButtonStyle(selected: selected?.id == entry.id))
                        }
                        if store.browse?.entries.isEmpty == true { Text("此目录没有可浏览的文件或子目录").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary).padding(24) }
                    }
                }.padding(.horizontal, 24).padding(.vertical, 10)
            }.disabled(store.connection != .secured)
            OrbisActionButton(title: "下载到手机", symbol: "arrow.down.to.line") {
                if let selected {
                    transfers.download(path: remoteBrowsePath(parent: store.browse?.path, name: selected.name)); onDismiss()
                }
            }.disabled(selected == nil || store.browse?.loading != false || store.browse?.error != nil || store.connection != .secured)
                .padding(.horizontal, 24).padding(.bottom, 24)
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onAppear { store.browseDirectory() }
            .onChange(of: store.selectedHostId) { _, _ in onDismiss() }
            .onChange(of: store.browse?.requestId) { _, _ in selected = nil }
    }
}

struct AttachmentStrip: View {
    @EnvironmentObject private var transfers: FileTransfers
    let runtime: RuntimeSummary
    var body: some View {
        let tasks = transfers.currentTasks.filter { $0.direction == "upload" && $0.runtimeId == runtime.runtimeId && $0.sessionId == runtime.sessionId && $0.attached }
        if transfers.preparing { ProgressView("正在准备附件…").font(.orbisCaption()).padding(.top, 10) }
        if !tasks.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(tasks) { task in
                        HStack(spacing: 10) {
                            Image(systemName: "doc")
                            VStack(alignment: .leading, spacing: 3) {
                                FileNameText(name: task.name).font(.orbisCaption(.medium))
                                HStack(spacing: 6) {
                                    Text(task.error ?? (task.status == "completed" ? "已上传" : transferStatusTitle(task.status))).lineLimit(1)
                                    if task.error == nil && task.status != "completed" { Text(byteCount(task.received)).fixedSize() }
                                }.font(.orbisCaption())
                            }.frame(maxWidth: 180, alignment: .leading)
                            if ["paused", "failed"].contains(task.status) {
                                OrbisIconButton(symbol: "arrow.clockwise", label: "重试上传", size: 28) { transfers.restart(task.id) }
                            }
                            OrbisIconButton(symbol: "xmark", label: "移除附件 \(task.name)", size: 28) { transfers.detach([task.id]) }
                        }.padding(.horizontal, 12).padding(.vertical, 6).neuSurface(inset: true, radius: 14, intensity: 0.45)
                    }
                }.padding(.horizontal, 16).padding(.vertical, 6).padding(.top, 4)
            }
        }
    }
}

func byteCount(_ count: Int64) -> String { ByteCountFormatter.string(fromByteCount: count, countStyle: .file) }
func transferStatusTitle(_ status: String) -> String {
    switch status {
    case "queued": return "等待传输"
    case "downloading": return "下载中"
    case "uploading": return "上传中"
    case "verifying": return "正在校验"
    case "completed": return "已完成"
    case "paused": return "已暂停"
    case "cancelled": return "已取消"
    default: return "失败"
    }
}
