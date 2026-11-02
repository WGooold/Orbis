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

/// Turn-end file summary, styled like the transcript's tool disclosures: one recessed block whose
/// header opens the viewer, one compact line per file, and a single caveat line when needed.
private struct TurnChangeCard: View {
    @ObservedObject var changes: TurnFileChanges
    let summary: TurnChangeSummary
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var expanded = false
    var body: some View {
        let p = OrbisPalette(scheme)
        let manifest = changes.manifest(summary)
        let ready = summary.state == "ready"
        let count = summary.fileCount ?? manifest.files.count
        let files = ready ? (expanded ? manifest.files : Array(manifest.files.prefix(4))) : []
        VStack(alignment: .leading, spacing: 6) {
            VStack(spacing: 0) {
                header(p, ready: ready, count: count, opens: ready && !files.isEmpty)
                ForEach(files) { file in
                    ChangeHairline()
                    OrbisMotionButton { changes.open(summary, fileId: file.fileId) } label: { ChangeFileLine(file: file) }
                        .buttonStyle(.plain).accessibilityIdentifier("turn-change-file-" + file.fileId)
                }
                if ready && count > 4 {
                    ChangeHairline()
                    OrbisMotionButton {
                        withAnimation(reduceMotion ? nil : .orbisCollapse) { expanded.toggle() }
                        if expanded && !manifest.started { changes.loadFiles(summary) }
                    } label: {
                        HStack(spacing: 6) {
                            Text(expanded ? "收起" : "还有 \(count - 4) 个文件")
                            Spacer(minLength: 0)
                            if manifest.loading { ProgressView().controlSize(.mini) }
                            OrbisActionSymbol(systemName: "chevron.down").imageScale(.small).rotationEffect(.degrees(expanded ? 180 : 0))
                        }.font(.orbisCaption()).foregroundStyle(p.secondary).frame(minHeight: 36).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if expanded && !manifest.complete && !manifest.loading && (manifest.started || manifest.error != nil) {
                    ChangeHairline()
                    OrbisMotionButton { changes.loadFiles(summary) } label: {
                        Text(manifest.error == nil ? "载入更多文件" : "重新读取文件清单")
                            .font(.orbisCaption()).foregroundStyle(manifest.error == nil ? p.accent : p.error)
                            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 12).padding(.vertical, 2).neuSurface(inset: true, radius: 14, intensity: 0.35)
            if let note = caveat {
                Label(note, systemImage: summary.coverage == "complete" ? "info.circle" : "exclamationmark.triangle")
                    .font(.orbisCaption()).foregroundStyle(summary.coverage == "complete" ? p.secondary : p.warning)
                    .padding(.horizontal, 4).accessibilityIdentifier("turn-changes-partial")
            }
        }.padding(.top, 4)
    }

    @ViewBuilder private func header(_ p: OrbisPalette, ready: Bool, count: Int, opens: Bool) -> some View {
        let pending = summary.state == "collecting" || summary.state == "finalizing"
        let title = pending ? "正在统计文件变化" : summary.state == "unavailable" ? "本轮文件变化未记录"
            : count == 0 ? (summary.coverage == "complete" ? "本轮没有文件变化" : "未发现文件变化") : "\(count) 个文件已更改"
        let row = HStack(spacing: 8) {
            OrbisActionSymbol(systemName: opens ? "doc.on.doc" : summary.state == "unavailable" ? "exclamationmark.circle" : "doc")
            Text(title).fontWeight(.medium).foregroundStyle(opens ? p.text : p.secondary).lineLimit(1)
            if pending { ProgressView().controlSize(.mini) }
            Spacer(minLength: 6)
            if opens {
                ChangeLineCounts(additions: summary.additions, deletions: summary.deletions, status: nil)
                OrbisActionSymbol(systemName: "chevron.right").imageScale(.small)
            }
        }.font(.orbisLabel()).foregroundStyle(p.secondary).frame(minHeight: 40).contentShape(Rectangle())
        if opens {
            OrbisMotionButton { changes.open(summary) } label: { row }.buttonStyle(.plain)
                .accessibilityLabel("查看详情，" + title).accessibilityIdentifier("turn-changes-open-" + summary.reviewTurnId)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    /// One line for what the counts cannot show: incomplete capture or concurrent edits.
    private var caveat: String? {
        turnChangeCoverageNote(summary)
    }
}

private struct ChangeHairline: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    var body: some View { Rectangle().fill(OrbisPalette(scheme).secondary.opacity(0.14)).frame(height: 0.5) }
}

/// Git-style status letter; VoiceOver reads the Chinese kind.
private struct ChangeKindLetter: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let kind: String
    var body: some View {
        let p = OrbisPalette(scheme)
        let (letter, tint): (String, Color) = switch kind {
        case "added": ("A", p.success)
        case "deleted": ("D", p.error)
        case "modified": ("M", p.warning)
        case "renamed": ("R", p.accent)
        case "type-changed": ("T", p.warning)
        default: ("?", p.secondary)
        }
        Text(letter).font(.orbisCaption(.bold, mono: true)).foregroundStyle(tint)
            .frame(width: 18, height: 18).background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .accessibilityLabel(turnChangeKindTitle(kind))
    }
}

/// Name first (middle-elided, extension kept), then the nearest directories, then counts.
private struct ChangeFileLine: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let file: TurnFileMetadata
    var body: some View {
        let p = OrbisPalette(scheme)
        let directory = file.path == file.name ? "" : String(file.path.dropLast(file.name.count + 1))
        let name = ReviewFileNameText(name: file.name, fullPath: file.path).font(.orbisLabel(mono: true)).foregroundStyle(p.text)
        let nearest = directory.split(separator: "/").last.map { directory.contains("/") ? "…/" + $0 : String($0) } ?? ""
        HStack(spacing: 8) {
            ChangeKindLetter(kind: file.changeKind)
            // The directory never squeezes the name: full, then nearest segment, then hidden.
            ViewThatFits(in: .horizontal) {
                ForEach(directory.isEmpty ? [] : directory == nearest ? [directory] : [directory, nearest], id: \.self) { shown in
                    HStack(spacing: 8) { name; Text(shown).font(.orbisCaption(mono: true)).foregroundStyle(p.secondary).lineLimit(1).fixedSize() }
                }
                name
            }
            Spacer(minLength: 6)
            ChangeLineCounts(additions: file.additions, deletions: file.deletions, status: turnChangeShortStatus(file.detail))
        }.frame(minHeight: 36).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }
}

/// The chat screen presents the viewer, not the lazily built transcript row that owns the card:
/// a row recycled while the agent keeps writing must not take an open review with it.
struct TurnFileReviewPresenter: ViewModifier {
    @ObservedObject var changes: TurnFileChanges
    @State private var showing = false
    func body(content: Content) -> some View {
        // The opened version stays until the sheet has left the screen, so closing slides the
        // same file out instead of an empty placeholder.
        content.sheet(isPresented: $showing, onDismiss: { changes.closeViewer() }) {
            TurnFileReviewView(changes: changes)
        }
        .onChange(of: changes.opened != nil, initial: true) { _, open in showing = open }
    }
}

private struct ChangeLineCounts: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let additions: Int?
    let deletions: Int?
    var status: String? = "—"
    var body: some View {
        let p = OrbisPalette(scheme)
        HStack(spacing: 5) {
            if additions == nil && deletions == nil {
                if let status { Text(status).foregroundStyle(p.secondary) }
            } else {
                if let additions, additions > 0 || (deletions ?? 0) == 0 { Text("+\(additions)").foregroundStyle(p.success) }
                if let deletions, deletions > 0 { Text("−\(deletions)").foregroundStyle(p.error) }
            }
        }.font(.orbisCaption(mono: true)).fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(additions == nil && deletions == nil ? (status ?? "行数未知")
                : "新增 \(additions.map(String.init) ?? "未知") 行，删除 \(deletions.map(String.init) ?? "未知") 行")
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

/// Only the header closes the card (pull down or ×). The sheet's own pull-to-close works just
/// for drags that begin in the header, so a diff scrolled past its top only bounces inside its
/// own well.
struct TurnFileReviewView: View {
    @ObservedObject var changes: TurnFileChanges
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisReduceMotion) private var reduceMotion
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
        let p = OrbisPalette(scheme)
        let files = changes.viewerFiles
        let index = files.firstIndex { $0.fileId == changes.selectedFileId } ?? 0
        VStack(spacing: 8) {
            header(p)
            if changes.newerVersionAvailable { OrbisNotice(text: "本轮概况已更新，当前保持打开时的版本。").padding(.horizontal, 16) }
            if changes.suspended {
                OrbisActionButton(title: "继续读取", symbol: "play") { changes.resume() }.padding(.horizontal, 16)
            }
            if !files.isEmpty {
                SettledFilePager(changes: changes, files: files, requestedFile: requestedFile, navigation: navigation, reduceMotion: pageReduceMotion)
                    .accessibilityIdentifier("turn-change-pager")
            } else if let summary = changes.opened, let error = changes.manifest(summary).error {
                OrbisNotice(text: error, error: true).padding(.horizontal, 16)
                OrbisActionButton(title: "重新读取文件清单", symbol: "arrow.clockwise") { changes.loadFiles(summary) }.padding(.horizontal, 16)
                Spacer()
            } else {
                OrbisEmptyState(symbol: "doc", title: "正在读取文件清单").frame(maxHeight: .infinity)
            }
            HStack {
                OrbisIconButton(symbol: "chevron.left", label: "上一个文件", size: 44) { request(files[index - 1].fileId) }.disabled(index == 0)
                Spacer()
                Text(files.isEmpty ? "没有文件" : "\(index + 1) / \(changes.opened?.fileCount ?? files.count)")
                    .font(.orbisLabel(.semibold, mono: true)).foregroundStyle(p.secondary).accessibilityIdentifier("turn-change-page")
                Spacer()
                OrbisIconButton(symbol: "chevron.right", label: "下一个文件", size: 44) { request(files[index + 1].fileId) }.disabled(index + 1 >= files.count)
            }.padding(.horizontal, 20)
            if let summary = changes.opened, index + 1 >= files.count, !changes.manifest(summary).complete, (summary.fileCount ?? 0) > files.count {
                OrbisTextButton(title: "载入更多文件", symbol: "doc", loading: changes.manifest(summary).loading) { changes.loadFiles(summary) }
            }
        }.padding(.bottom, 4)
            .foregroundStyle(p.text)
            .environment(\.orbisSurface, nil)
            .presentationDetents([.large])
            .presentationDragIndicator(.hidden)
            .presentationContentInteraction(.scrolls)
            .presentationCornerRadius(OrbisRadius.sheet)
            .presentationBackground(p.base)
            #if DEBUG
            .overlay(alignment: .bottom) {
                if ProcessInfo.processInfo.arguments.contains("--preview-screen=changes") { TurnChangesRequestProbeView() }
            }
            #endif
            .onChange(of: scenePhase) { _, phase in if phase != .active { changes.suspend() } }
            .onChange(of: changes.opened == nil) { _, closed in if closed { dismiss() } }
            .onDisappear { changes.closeViewer() }
    }
    private func header(_ p: OrbisPalette) -> some View {
        VStack(spacing: 0) {
            Capsule().fill(.clear).frame(width: 40, height: 6)
                .neuSurface(inset: true, radius: 3, intensity: 0.35, concentric: false)
                .padding(.top, 7).accessibilityHidden(true)
            OrbisHeader {
                OrbisIconButton(symbol: "xmark", label: "关闭", action: { dismiss() })
            } title: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("本轮文件差异").font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
                    if let summary = changes.opened {
                        Text(turnChangeScopeTitle(summary.scope)).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
                    }
                }
            } trailing: { EmptyView() }
        }.background(SheetDismissZone())
            .accessibilityElement(children: .contain).accessibilityIdentifier("turn-change-header")
    }
    private func request(_ file: String) { requestedFile = file; navigation += 1 }
}

/// The header's footprint for the sheet's own pull-to-close. At every touch-down in the
/// window, before the sheet's pan can start, the presented controller becomes modal unless the
/// touch landed here. The observer never receives or claims the touch.
private struct SheetDismissZone: UIViewRepresentable {
    func makeUIView(context: Context) -> ZoneView { ZoneView() }
    func updateUIView(_ view: ZoneView, context: Context) {}

    final class ZoneView: UIView, UIGestureRecognizerDelegate {
        private var observer: UIGestureRecognizer?
        override init(frame: CGRect) { super.init(frame: frame); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let observer { observer.view?.removeGestureRecognizer(observer) }
            observer = nil
            guard let window else { return }
            let observer = UIGestureRecognizer()
            observer.delegate = self
            window.addGestureRecognizer(observer)
            self.observer = observer
            presented?.isModalInPresentation = true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            presented?.isModalInPresentation = !bounds.contains(touch.location(in: self))
            return false
        }
        private var presented: UIViewController? {
            var controller = sequence(first: self as UIResponder, next: \.next).first { $0 is UIViewController } as? UIViewController
            while let parent = controller?.parent { controller = parent }
            return controller
        }
    }
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
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @State private var position: Int?
    @State private var restored = false
    @State private var userScrolled = false
    @State private var pageEdgeArmed = true
    var body: some View {
        let detail = changes.detail(for: file)
        let selected = changes.selectedFileId == file.fileId
        // Monospaced caption digits are 7.2pt wide; gutters fit the widest number read so far.
        let gutter = CGFloat(max(2, String(detail.parser.maxLineNumber).count)) * 7.5
        VStack(alignment: .leading, spacing: 10) {
            DiffFileHeader(file: file)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(detail.lines) { line in DiffLineView(line: line, gutter: gutter).id(line.id) }
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
                    .padding(.vertical, 6)
                    .background(DiffScrollObservation { userScrolled = true })
            }.scrollPosition(id: $position, anchor: .top)
                .onAppear { if !restored { position = detail.scrollLine; restored = true } }
                .onChange(of: position) { _, value in if selected && restored { changes.rememberScroll(value, file: file) } }
                .background(OrbisPalette(scheme).well)
                .clipShape(RoundedRectangle(cornerRadius: OrbisRadius.control, style: .continuous))
                .accessibilityIdentifier("turn-change-diff")
        }.padding(.horizontal, 16)
    }
}

/// Name, kind and counts slide with their page, so a settled swipe never relabels the
/// previous file. Long-press copies the full path.
private struct DiffFileHeader: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let file: TurnFileMetadata
    var body: some View {
        let p = OrbisPalette(scheme)
        let directory = file.path == file.name ? "" : String(file.path.dropLast(file.name.count))
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                ChangeKindBadge(kind: file.changeKind)
                ReviewFileNameText(name: file.name, fullPath: file.path).font(.orbisBody(.semibold, mono: true))
                Spacer(minLength: 4)
                ChangeLineCounts(additions: file.additions, deletions: file.deletions, status: turnChangeShortStatus(file.detail))
            }
            if !directory.isEmpty {
                Text(directory).font(.orbisCaption(mono: true)).foregroundStyle(p.secondary).lineLimit(1).truncationMode(.middle)
            }
            if let old = file.oldPath {
                Text("原路径：" + old).font(.orbisCaption(mono: true)).foregroundStyle(p.secondary).lineLimit(1).truncationMode(.middle)
            }
        }.padding(.horizontal, 4).padding(.top, 2)
            .contentShape(Rectangle())
            .contextMenu { OrbisMotionButton { UIPasteboard.general.string = file.path } label: { Label("复制路径", systemImage: "doc.on.doc") } }
    }
}

private struct ChangeKindBadge: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let kind: String
    var body: some View {
        let p = OrbisPalette(scheme)
        let tint = kind == "added" ? p.success : kind == "deleted" ? p.error : kind == "renamed" ? p.accent : kind == "unknown" ? p.secondary : p.warning
        Text(turnChangeKindTitle(kind)).font(.orbisCaption(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tint.opacity(0.14), in: Capsule())
    }
}

/// Git-style row: old / new numbers, a +/− marker column and the line body. Hunk and file
/// headers span the row; continuation fragments of a long line carry neither number nor marker.
private struct DiffLineView: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    let line: DiffDisplayLine
    let gutter: CGFloat
    var body: some View {
        let p = OrbisPalette(scheme)
        let tint: Color? = line.kind == .addition ? p.success : line.kind == .deletion ? p.error : nil
        let marked = !line.continuation && line.kind != .header && line.kind != .note
        Group {
            if line.kind == .header || line.kind == .note {
                let hunk = line.text.hasPrefix("@@")
                Text(line.text).foregroundStyle(hunk ? p.accent : p.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, hunk ? 5 : 1)
                    .background(hunk ? p.lift : Color.clear)
                    .padding(.vertical, hunk ? 4 : 0)
            } else {
                HStack(alignment: .top, spacing: 0) {
                    Text(line.oldLine.map(String.init) ?? "").frame(width: gutter, alignment: .trailing)
                    Text(line.newLine.map(String.init) ?? "").frame(width: gutter, alignment: .trailing).padding(.leading, 6)
                    Text(line.kind == .addition && marked ? "+" : line.kind == .deletion && marked ? "−" : "")
                        .frame(width: 18).foregroundStyle(tint ?? p.secondary)
                    Text(marked ? String(line.text.dropFirst()) : line.text).foregroundStyle(tint ?? p.text)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.foregroundStyle(p.secondary)
                    .padding(.leading, 4).padding(.trailing, 10).padding(.vertical, 1.5)
                    .background(tint?.opacity(0.12) ?? Color.clear)
            }
        }.font(.orbisCaption(mono: true))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(line.text)
            .accessibilityValue([line.oldLine.map { "旧 \($0)" }, line.newLine.map { "新 \($0)" }].compactMap { $0 }.joined(separator: "，"))
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
