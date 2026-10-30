import SwiftUI
import UIKit

struct TurnChangeCards: View {
    @ObservedObject var changes: TurnFileChanges
    let anchors: Set<String>
    let turns: Set<String>
    var body: some View {
        ForEach(changes.matching(anchors: anchors, turns: turns)) { summary in
            TurnChangeCard(changes: changes, summary: summary)
        }
    }
}

private struct TurnChangeCard: View {
    @ObservedObject var changes: TurnFileChanges
    let summary: TurnChangeSummary
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var showing = false
    var body: some View {
        let p = OrbisPalette(scheme)
        let manifest = changes.manifest(summary)
        let files = expanded ? manifest.files : Array(manifest.files.prefix(4))
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(summary.state == "finalizing" || summary.state == "collecting" ? "正在统计文件变化" : "本轮文件变化").font(.orbisLabel(.semibold))
                Spacer(minLength: 4)
                if let count = summary.fileCount { Text("\(count) 个文件").font(.orbisCaption()).foregroundStyle(p.secondary) }
            }
            if summary.state == "ready" {
                HStack(spacing: 12) {
                    if let count = summary.addedFiles { Text("新增 \(count)") }
                    if let count = summary.modifiedFiles { Text("修改 \(count)") }
                    if let count = summary.deletedFiles { Text("删除 \(count)") }
                    Spacer(minLength: 0)
                    ChangeLineCounts(additions: summary.additions, deletions: summary.deletions)
                }.font(.orbisCaption()).foregroundStyle(p.secondary)
                ForEach(files) { file in
                    Button { changes.open(summary, fileId: file.fileId); showing = true } label: {
                        ChangeMetadataRow(file: file)
                    }.buttonStyle(.plain).accessibilityIdentifier("turn-change-file-" + file.fileId)
                }
                if (summary.fileCount ?? 0) > 4 {
                    Button {
                        withAnimation(reduceMotion ? nil : .orbisCollapse) { expanded.toggle() }
                        if expanded && !manifest.started { changes.loadFiles(summary) }
                    } label: {
                        Label(expanded ? "收起文件清单" : "显示全部文件", systemImage: expanded ? "chevron.up" : "chevron.down")
                            .font(.orbisLabel()).frame(minHeight: 48)
                    }.buttonStyle(.plain)
                }
                if expanded && !manifest.complete && (manifest.started || manifest.loading || manifest.error != nil) {
                    OrbisTextButton(title: manifest.error == nil ? "更多文件" : "重新读取清单", symbol: "doc", loading: manifest.loading) { changes.loadFiles(summary) }
                    if let error = manifest.error { Text(error).font(.orbisCaption()).foregroundStyle(p.error) }
                }
                if !files.isEmpty {
                    OrbisActionButton(title: "查看详情", symbol: "doc.text.magnifyingglass") { changes.open(summary); showing = true }
                        .accessibilityIdentifier("turn-changes-open-" + summary.reviewTurnId)
                }
                if summary.fileCount == 0 { Text("采集范围内没有净变化").font(.orbisCaption()).foregroundStyle(p.secondary) }
            } else if summary.state == "unavailable" {
                Text("此轮未取得可比较的前后版本。").font(.orbisCaption()).foregroundStyle(p.secondary)
            }
            if summary.coverage != "complete" {
                Text("仅记录部分范围，未完整捕获轮次边界或文件内容。")
                    .font(.orbisCaption()).foregroundStyle(p.warning).accessibilityIdentifier("turn-changes-partial")
            }
            Text(turnChangeScopeTitle(summary.scope)).font(.orbisCaption()).foregroundStyle(p.secondary)
            Text("工作区同期净变化，修改归属未确认").font(.orbisCaption()).foregroundStyle(p.secondary)
        }.padding(.top, 8)
            .sheet(isPresented: $showing, onDismiss: { changes.closeViewer() }) {
                TurnFileReviewView(changes: changes).orbisSheet([.large])
            }
            .onChange(of: changes.opened == nil) { _, closed in if closed { showing = false } }
    }
}

private struct ChangeLineCounts: View {
    @Environment(\.colorScheme) private var scheme
    let additions: Int?
    let deletions: Int?
    var body: some View {
        HStack(spacing: 6) {
            Text(additions.map { "+\($0)" } ?? "+—").foregroundStyle(OrbisPalette(scheme).success)
            Text(deletions.map { "−\($0)" } ?? "−—").foregroundStyle(OrbisPalette(scheme).error)
        }.font(.orbisCaption(mono: true)).fixedSize()
            .accessibilityLabel("新增 \(additions.map(String.init) ?? "未知") 行，删除 \(deletions.map(String.init) ?? "未知") 行")
    }
}

struct ReviewFileNameText: View {
    let name: String
    let fullPath: String
    var body: some View {
        let parts = reviewFileNameParts(name)
        HStack(spacing: 0) {
            Text(parts.stem).lineLimit(1).truncationMode(.middle)
            if !parts.ext.isEmpty { Text(parts.ext).lineLimit(1).fixedSize() }
        }.accessibilityElement(children: .ignore).accessibilityLabel(fullPath)
    }
}

private struct ChangeMetadataRow: View {
    @Environment(\.colorScheme) private var scheme
    let file: TurnFileMetadata
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(turnChangeKindTitle(file.changeKind)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                ReviewFileNameText(name: file.name, fullPath: file.path).font(.orbisLabel(mono: true))
                Spacer(minLength: 0)
                ChangeLineCounts(additions: file.additions, deletions: file.deletions)
            }
            if file.path != file.name { Text(file.path).font(.orbisCaption(mono: true)).lineLimit(1).truncationMode(.middle).foregroundStyle(OrbisPalette(scheme).secondary) }
        }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }
}

struct TurnFileReviewView: View {
    @ObservedObject var changes: TurnFileChanges
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var navigation: Int = 0
    @State private var requestedFile: String?
    private var pageReduceMotion: Bool {
        #if DEBUG
        return reduceMotion || ProcessInfo.processInfo.arguments.contains("--preview-reduce-motion")
        #else
        return reduceMotion
        #endif
    }
    var body: some View {
        let files = changes.viewerFiles
        let index = files.firstIndex { $0.fileId == changes.selectedFileId } ?? 0
        VStack(spacing: 12) {
            OrbisPageHeader(title: "本轮文件差异", closes: true, back: { dismiss() }) { EmptyView() }
            if let file = changes.selectedFile {
                VStack(alignment: .leading, spacing: 6) {
                    ReviewFileNameText(name: file.name, fullPath: file.path).font(.orbisBody(.semibold, mono: true))
                    Text(file.path).font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary).textSelection(.enabled)
                    if let old = file.oldPath { Text("原路径：" + old).font(.orbisCaption(mono: true)).textSelection(.enabled) }
                    HStack { Text(turnChangeKindTitle(file.changeKind)).font(.orbisCaption()); Spacer(); ChangeLineCounts(additions: file.additions, deletions: file.deletions) }
                }.padding(.horizontal, 24)
            }
            if let summary = changes.opened { Text(turnChangeScopeTitle(summary.scope)).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).padding(.horizontal, 24) }
            if changes.newerVersionAvailable { OrbisNotice(text: "本轮概况已更新，当前保持打开时的版本。").padding(.horizontal, 20) }
            if changes.suspended {
                OrbisActionButton(title: "继续读取", symbol: "play") { changes.resume() }.padding(.horizontal, 20)
            }
            if !files.isEmpty {
                SettledFilePager(changes: changes, files: files, requestedFile: requestedFile, navigation: navigation, reduceMotion: pageReduceMotion)
                    .accessibilityIdentifier("turn-change-pager")
            } else if let summary = changes.opened, let error = changes.manifest(summary).error {
                OrbisNotice(text: error, error: true).padding(.horizontal, 20)
                OrbisActionButton(title: "重新读取文件清单", symbol: "arrow.clockwise") { changes.loadFiles(summary) }.padding(.horizontal, 20)
                Spacer()
            } else {
                OrbisEmptyState(symbol: "doc", title: "正在读取文件清单")
            }
            HStack {
                OrbisIconButton(symbol: "chevron.left", label: "上一个文件", size: 48) { request(files[index - 1].fileId) }.disabled(index == 0)
                Spacer()
                Text(files.isEmpty ? "没有文件" : "\(index + 1) / \(changes.opened?.fileCount ?? files.count)")
                    .font(.orbisLabel(mono: true)).accessibilityIdentifier("turn-change-page")
                Spacer()
                OrbisIconButton(symbol: "chevron.right", label: "下一个文件", size: 48) { request(files[index + 1].fileId) }.disabled(index + 1 >= files.count)
            }.padding(.horizontal, 20)
            if let summary = changes.opened, index + 1 >= files.count, !changes.manifest(summary).complete, (summary.fileCount ?? 0) > files.count {
                OrbisTextButton(title: "载入更多文件", symbol: "doc", loading: changes.manifest(summary).loading) { changes.loadFiles(summary) }
                    .padding(.bottom, 8)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea()).foregroundStyle(OrbisPalette(scheme).text)
            #if DEBUG
            .overlay(alignment: .bottom) {
                if ProcessInfo.processInfo.arguments.contains("--preview-screen=changes") { TurnChangesRequestProbeView() }
            }
            #endif
            .onChange(of: scenePhase) { _, phase in if phase != .active { changes.suspend() } }
            .onChange(of: changes.opened == nil) { _, closed in if closed { dismiss() } }
            .onDisappear { changes.closeViewer() }
    }
    private func request(_ file: String) { requestedFile = file; navigation += 1 }
}

/// UIKit calls didFinishAnimating only after a swipe settles. Building its adjacent
/// controllers is metadata/cache-only and never opens a network read.
private struct SettledFilePager: UIViewControllerRepresentable {
    @ObservedObject var changes: TurnFileChanges
    let files: [TurnFileMetadata]
    let requestedFile: String?
    let navigation: Int
    let reduceMotion: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIPageViewController {
        let page = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
        page.dataSource = context.coordinator; page.delegate = context.coordinator
        if let file = files.first(where: { $0.fileId == changes.selectedFileId }) ?? files.first {
            page.setViewControllers([context.coordinator.controller(file)], direction: .forward, animated: false)
        }
        return page
    }
    func updateUIViewController(_ page: UIPageViewController, context: Context) {
        context.coordinator.parent = self
        guard navigation != context.coordinator.navigation, let target = requestedFile,
              let file = files.first(where: { $0.fileId == target }), !context.coordinator.transitioning else { return }
        context.coordinator.navigation = navigation
        let current = files.firstIndex { $0.fileId == changes.selectedFileId } ?? 0
        let next = files.firstIndex { $0.fileId == target } ?? current
        context.coordinator.transitioning = true
        page.setViewControllers([context.coordinator.controller(file)], direction: next < current ? .reverse : .forward, animated: !reduceMotion) { completed in
            context.coordinator.transitioning = false
            if completed { changes.selectFile(target) }
        }
    }
    final class Page: UIHostingController<DiffFilePage> {
        let fileId: String
        init(file: TurnFileMetadata, changes: TurnFileChanges) { fileId = file.fileId; super.init(rootView: DiffFilePage(changes: changes, file: file)); view.backgroundColor = .clear }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    }
    final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
        var parent: SettledFilePager
        var navigation = 0
        var transitioning = false
        init(_ parent: SettledFilePager) { self.parent = parent }
        func controller(_ file: TurnFileMetadata) -> Page { Page(file: file, changes: parent.changes) }
        func pageViewController(_ page: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? { adjacent(viewController, delta: -1) }
        func pageViewController(_ page: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? { adjacent(viewController, delta: 1) }
        private func adjacent(_ controller: UIViewController, delta: Int) -> UIViewController? {
            guard let current = controller as? Page, let index = parent.files.firstIndex(where: { $0.fileId == current.fileId }), parent.files.indices.contains(index + delta) else { return nil }
            return self.controller(parent.files[index + delta])
        }
        func pageViewController(_ page: UIPageViewController, willTransitionTo pendingViewControllers: [UIViewController]) { transitioning = true }
        func pageViewController(_ page: UIPageViewController, didFinishAnimating finished: Bool, previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
            transitioning = false
            if completed, let selected = page.viewControllers?.first as? Page { parent.changes.selectFile(selected.fileId) }
        }
    }
}

private struct DiffFilePage: View {
    @ObservedObject var changes: TurnFileChanges
    let file: TurnFileMetadata
    @Environment(\.colorScheme) private var scheme
    @State private var position: Int?
    @State private var restored = false
    @State private var userScrolled = false
    @State private var pageEdgeArmed = true
    var body: some View {
        let detail = changes.detail(for: file)
        let selected = changes.selectedFileId == file.fileId
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(detail.lines) { line in DiffLineView(line: line).id(line.id) }
                VStack(spacing: 10) {
                    if let error = detail.error {
                        OrbisNotice(text: error, error: file.detail == "available")
                        if file.detail == "available" && !detail.limitReached { OrbisActionButton(title: "重新读取", symbol: "arrow.clockwise") { changes.loadNext() }.disabled(!selected || changes.suspended) }
                    } else if detail.loading {
                        ProgressView("读取差异…").font(.orbisLabel())
                    } else if detail.eof {
                        Text(detail.lines.isEmpty ? "此文件没有文本差异" : "已显示完整差异").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                    } else if selected {
                        OrbisActionButton(title: "继续读取", symbol: "arrow.down") { changes.loadNext() }.disabled(changes.suspended)
                    } else {
                        Text("切换到此文件后读取差异").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                    }
                }.padding(16).frame(maxWidth: .infinity, minHeight: 80)
                    .onAppear {
                        if selected && userScrolled && pageEdgeArmed && detail.nextCursor != nil && detail.error == nil {
                            pageEdgeArmed = false; changes.loadNext()
                        }
                    }.onDisappear { pageEdgeArmed = true }
            }.scrollTargetLayout()
                .background(DiffScrollObservation { userScrolled = true })
        }.scrollPosition(id: $position, anchor: .top)
            .onAppear { if !restored { position = detail.scrollLine; restored = true } }
            .onChange(of: position) { _, value in if selected && restored { changes.rememberScroll(value, file: file) } }
            .background(OrbisPalette(scheme).well)
            .clipShape(RoundedRectangle(cornerRadius: OrbisRadius.control, style: .continuous))
            .padding(.horizontal, 12)
    }
}

private struct DiffLineView: View {
    @Environment(\.colorScheme) private var scheme
    let line: DiffDisplayLine
    var body: some View {
        let p = OrbisPalette(scheme)
        HStack(alignment: .top, spacing: 8) {
            Text(line.oldLine.map(String.init) ?? "").frame(width: 42, alignment: .trailing).foregroundStyle(p.secondary)
            Text(line.newLine.map(String.init) ?? "").frame(width: 42, alignment: .trailing).foregroundStyle(p.secondary)
            Text(line.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }.font(.orbisCaption(mono: true)).padding(.horizontal, 8).padding(.vertical, 2)
            .background(line.kind == .addition ? p.success.opacity(0.12) : line.kind == .deletion ? p.error.opacity(0.12) : line.kind == .header ? p.lift : Color.clear)
            .foregroundStyle(line.kind == .addition ? p.success : line.kind == .deletion ? p.error : p.text)
            .accessibilityElement(children: .combine)
    }
}

/// Observe the native vertical scroll recognizer without adding a competing drag
/// recognizer; the enclosing page controller retains horizontal swipe ownership.
private struct DiffScrollObservation: UIViewRepresentable {
    let moved: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(moved) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false
        DispatchQueue.main.async { context.coordinator.attach(view) }; return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.moved = moved
        DispatchQueue.main.async { context.coordinator.attach(view) }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.detach() }
    final class Coordinator: NSObject {
        var moved: () -> Void
        weak var scroll: UIScrollView?
        init(_ moved: @escaping () -> Void) { self.moved = moved }
        func attach(_ view: UIView) {
            guard scroll == nil else { return }
            var parent = view.superview
            while let candidate = parent {
                if let found = candidate as? UIScrollView {
                    scroll = found; found.panGestureRecognizer.addTarget(self, action: #selector(pan)); return
                }
                parent = candidate.superview
            }
        }
        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            guard gesture.state == .changed else { return }
            let delta = gesture.translation(in: gesture.view)
            if abs(delta.y) > abs(delta.x) { moved() }
        }
        func detach() { scroll?.panGestureRecognizer.removeTarget(self, action: #selector(pan)); scroll = nil }
    }
}
