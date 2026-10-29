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
    private var downloads: [FileTransfer] { transfers.currentTasks.filter { $0.direction == "download" } }
    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: selected.isEmpty ? "下载" : "已选择 \(selected.count) 项", back: { if selected.isEmpty { onBack() } else { selected = [] } }) {
                if !selected.isEmpty {
                    OrbisIconButton(symbol: "trash", label: "删除所选下载", tint: OrbisPalette(scheme).error, action: confirmDelete)
                }
            }
            HStack(spacing: 10) {
                TextField("电脑文件的完整路径", text: $path).textInputAutocapitalization(.never).autocorrectionDisabled().orbisInput().accessibilityIdentifier("download-path")
                OrbisIconButton(symbol: "arrow.down.to.line", label: "按路径下载") { transfers.download(path: path.trimmingCharacters(in: .whitespacesAndNewlines)); path = "" }
                    .disabled(store.connection != .secured || path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(.horizontal, 24).padding(.top, 8)
            OrbisActionButton(title: "浏览电脑文件", symbol: "folder") { browserOpen = true }
                .disabled(store.connection != .secured).padding(.horizontal, 24).padding(.vertical, 12)
            if downloads.isEmpty { OrbisEmptyState(symbol: "arrow.down.to.line", title: "暂无下载", detail: "浏览电脑文件，或点击消息中的文件链接下载。") }
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

    private func transferCard(_ task: FileTransfer) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "doc").font(.system(size: 24)).foregroundStyle(OrbisPalette(scheme).accent)
                VStack(alignment: .leading, spacing: 5) {
                    Text(task.name).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                    Text(store.selectedHost?.hostName ?? "电脑").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if !selected.isEmpty {
                    OrbisCheckbox(checked: selected.contains(task.id), label: "选择 \(task.name)") {
                        if !selected.insert(task.id).inserted { selected.remove(task.id) }
                    }
                }
            }
            HStack {
                Text(transferStatusTitle(task.status)).font(.system(size: 12, weight: .medium))
                Spacer()
                Text("\(byteCount(task.received)) / \(byteCount(task.size))").font(.system(size: 11, design: .monospaced))
            }.foregroundStyle(task.status == "failed" ? OrbisPalette(scheme).error : OrbisPalette(scheme).secondary)
            if task.size > 0 && ["downloading", "queued", "paused", "verifying"].contains(task.status) {
                ProgressView(value: min(Double(task.size), Double(task.received)), total: Double(task.size)).tint(OrbisPalette(scheme).accent)
            }
            if let error = task.error { Text(error).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).error) }
            if task.status == "completed", let path = task.localPath {
                Text("已保存到“文件”App · Orbis").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                ShareLink(item: URL(fileURLWithPath: path)) {
                    Label("打开或分享", systemImage: "square.and.arrow.up").font(.system(size: 13, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 48)
                }.buttonStyle(NeuButtonStyle())
            } else if ["queued", "downloading", "verifying"].contains(task.status) {
                OrbisActionButton(title: "取消", symbol: "xmark") { transfers.cancel(task.id) }
            } else {
                OrbisActionButton(title: task.status == "paused" ? "继续下载" : "重试", symbol: "arrow.clockwise") { transfers.restart(task.id) }.disabled(store.connection != .secured)
            }
        }.padding(18).neuSurface(inset: selected.contains(task.id))
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
                        Text(store.browse?.path.flatMap { $0.isEmpty ? nil : $0 } ?? "电脑根目录").font(.system(size: 12, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
                        if store.browse?.loading == true { ProgressView().controlSize(.small) }
                        else { OrbisIconButton(symbol: "arrow.clockwise", label: "刷新目录") { store.browseDirectory(store.browse?.path) } }
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
                                    Text(entry.name).font(.system(size: 14)).frame(maxWidth: .infinity, alignment: .leading)
                                    if entry.isDir { Image(systemName: "chevron.right").font(.system(size: 12)) }
                                    else if selected?.id == entry.id { Image(systemName: "checkmark.circle.fill") }
                                }.padding(14).frame(minHeight: 52)
                            }.buttonStyle(NeuButtonStyle(selected: selected?.id == entry.id))
                        }
                        if store.browse?.entries.isEmpty == true { Text("此目录没有可浏览的文件或子目录").font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary).padding(24) }
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
        if transfers.preparing { ProgressView("正在准备附件…").font(.system(size: 12)) }
        if !tasks.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(tasks) { task in
                        HStack(spacing: 10) {
                            Image(systemName: "doc")
                            VStack(alignment: .leading, spacing: 3) {
                                Text(task.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Text(task.error ?? (task.status == "completed" ? "已上传" : "\(transferStatusTitle(task.status)) · \(byteCount(task.received))"))
                                    .font(.system(size: 10)).lineLimit(1)
                            }.frame(maxWidth: 180, alignment: .leading)
                            if ["paused", "failed"].contains(task.status) {
                                OrbisIconButton(symbol: "arrow.clockwise", label: "重试上传", size: 28) { transfers.restart(task.id) }
                            }
                            OrbisIconButton(symbol: "xmark", label: "移除附件 \(task.name)", size: 28) { transfers.detach([task.id]) }
                        }.padding(.horizontal, 12).padding(.vertical, 6).neuSurface(inset: true, radius: 14, intensity: 0.45)
                    }
                }.padding(.horizontal, 16).padding(.vertical, 6)
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
