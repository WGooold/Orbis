import SwiftUI

struct DownloadsView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var transfers: FileTransfers
    @EnvironmentObject private var overlay: OrbisOverlay
    @Environment(\.colorScheme) private var scheme
    let onBack: () -> Void
    @State private var browserOpen = false
    @State private var selected: Set<String> = []
    private var downloads: [FileTransfer] { transfers.currentTasks.filter { $0.direction == "download" } }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: selected.isEmpty ? "下载" : "已选择 \(selected.count) 项", back: { if selected.isEmpty { onBack() } else { selected = [] } }) {
                if !selected.isEmpty {
                    OrbisIconButton(symbol: "trash", label: "删除所选下载", tint: OrbisPalette(scheme).error, action: confirmDelete)
                }
            }
            OrbisActionButton(title: "浏览电脑文件", symbol: "folder") { browserOpen = true }
                .disabled(store.connection != .secured).padding(.horizontal, 24).padding(.vertical, 12)
            if downloads.isEmpty { OrbisEmptyState(symbol: "arrow.down.to.line", title: "暂无下载") }
            else {
                ScrollView {
                    LazyVStack(spacing: 18) {
                        ForEach(downloads) { task in
                            transferCard(task).onLongPressGesture { selected.insert(task.id) }
                        }
                    }.padding(24)
                }
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .sheet(isPresented: $browserOpen, onDismiss: store.dismissBrowse) {
                DownloadBrowserView { browserOpen = false }.orbisSheet([.large])
            }
    }

    private func confirmDelete() {
        let ids = selected
        overlay.showDialog("删除下载记录与本机文件？", message: "电脑上的原文件不受影响。", actions: [
            OrbisDialogAction(title: "取消", role: .cancel),
            OrbisDialogAction(title: "删除 \(ids.count) 项", role: .destructive) { transfers.remove(ids); selected = [] }
        ])
    }

    /// Every status uses the same rows: name, one status line, one action slot and the progress
    /// track. A status change only swaps content in place, so cards below never move.
    private func transferCard(_ task: FileTransfer) -> some View {
        let p = OrbisPalette(scheme)
        let failed = task.status == "failed"
        let active = ["queued", "downloading", "verifying"].contains(task.status)
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ZStack {
                    if selected.isEmpty { Image(systemName: "doc").font(.system(size: 22)).foregroundStyle(p.accent) }
                    else {
                        OrbisCheckbox(checked: selected.contains(task.id), label: "选择 \(task.name)") {
                            if !selected.insert(task.id).inserted { selected.remove(task.id) }
                        }
                    }
                }.frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 4) {
                    FileNameText(name: task.name).font(.orbisBody(.semibold))
                    HStack(spacing: 8) {
                        Text(task.error ?? transferStatusTitle(task.status)).lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(byteCount(task.received)) / \(byteCount(task.size))").fixedSize()
                    }.font(.orbisCaption()).foregroundStyle(failed ? p.error : p.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Group {
                    if task.status == "completed", let path = task.localPath {
                        ShareLink(item: URL(fileURLWithPath: path)) {
                            Image(systemName: "square.and.arrow.up").font(.system(size: 20, weight: .medium)).foregroundStyle(p.accent)
                                .frame(width: 40, height: 40)
                        }.buttonStyle(NeuIconButtonStyle(selected: false)).accessibilityLabel("打开或分享")
                    } else if active {
                        OrbisIconButton(symbol: "xmark", label: "取消下载") { transfers.cancel(task.id) }
                    } else {
                        OrbisIconButton(symbol: "arrow.clockwise", label: task.status == "paused" ? "继续下载" : "重试", tint: p.accent) { transfers.restart(task.id) }
                            .disabled(store.connection != .secured)
                    }
                }.frame(width: 48, height: 48)
            }
            ProgressView(value: min(Double(max(task.size, 1)), Double(task.received)), total: Double(max(task.size, 1)))
                .tint(failed ? p.error : task.status == "completed" ? p.success : p.accent)
                .accessibilityHidden(true)
        }.neuSurface(inset: selected.contains(task.id), radius: OrbisRadius.card, padding: 16)
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
            OrbisPageHeader(title: "浏览电脑文件", back: onDismiss) { EmptyView() }
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
