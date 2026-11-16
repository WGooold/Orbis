import SwiftUI
import UIKit

/// New review actions require the source that built this UI to remain the Hub target.
/// Connection readiness is deliberately not part of ownership: cached files stay browsable.
@MainActor private func ownsTurnChanges(_ changes: TurnFileChanges, context: ChatReadContext?) -> Bool {
    guard let context else { return false }
    return context.isCurrent && context.connection.turnFileChanges === changes
}

@MainActor @Observable
final class TurnChangeSummaryState {
    var summaries: [TurnChangeSummary] = []
}

/// Attach asynchronous work to the material row, not an initially empty ForEach.
/// Its state belongs to that row's page reference and survives native reuse.
struct TurnChangeSummaryLoader: ViewModifier {
    let changes: TurnFileChanges?
    let anchors: Set<String>
    let state: TurnChangeSummaryState
    func body(content: Content) -> some View {
        let loads = changes != nil && !anchors.isEmpty
        Group {
            if let changes, loads {
                content.modifier(ObservedTurnChangeSummaryLoader(changes: changes, anchors: anchors, state: state))
            } else { content }
        }
        // A later row of the same turn takes over the anchors when a tool call splits
        // the reply. The row-owned summaries outlive cell reuse, so release them here.
        .onChange(of: loads, initial: true) { _, loads in
            if !loads, !state.summaries.isEmpty { state.summaries = [] }
        }
    }
}

private struct ObservedTurnChangeSummaryLoader: ViewModifier {
    @ObservedObject var changes: TurnFileChanges
    let anchors: Set<String>
    let state: TurnChangeSummaryState
    func body(content: Content) -> some View {
        let query = TurnChangeSummaryQuery(owner: changes.summaryProjectionOwner, revision: changes.summaryRevision, anchors: anchors)
        let summaries = changes.summaries
        let agent = changes.summaryProjectionAgent
        content.task(id: query) {
            let result = await TurnChangeBackgroundWorker.shared.matching(query, summaries: summaries, agent: agent)
            guard !Task.isCancelled else { return }
            if state.summaries != result { state.summaries = result }
        }
    }
}

struct TurnChangeCards: View {
    @ObservedObject var changes: TurnFileChanges
    let context: ChatReadContext?
    let state: TurnChangeSummaryState
    var body: some View {
        ForEach(state.summaries) { summary in
            TurnChangeCard(changes: changes, context: context, summary: summary)
        }
    }
}

/// Turn-end file summary, styled like the transcript's tool disclosures: one recessed block whose
/// header opens the viewer, one compact line per file, and a single caveat line when needed.
private struct TurnChangeCard: View {
    @ObservedObject var changes: TurnFileChanges
    let context: ChatReadContext?
    let summary: TurnChangeSummary
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.chatTranscriptRowInteraction) private var rowInteraction
    @Environment(\.chatReadingInteraction) private var beginReading
    @State private var localExpanded = false
    private var expansion: Binding<Bool> {
        if let state = rowInteraction?.disclosure("turn-changes:" + summary.id) {
            return Binding(get: { state.expanded }, set: { state.expanded = $0 })
        }
        return $localExpanded
    }
    var body: some View {
        let expanded = expansion.wrappedValue
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
                    OrbisMotionButton { open(fileId: file.fileId) } label: { ChangeFileLine(file: file) }
                        .buttonStyle(.plain).accessibilityIdentifier("turn-change-file-" + file.fileId)
                }
                if ready && count > 4 {
                    ChangeHairline()
                    OrbisMotionButton {
                        beginReading()
                        withAnimation(reduceMotion ? nil : .orbisCollapse) { expansion.wrappedValue.toggle() }
                        if expansion.wrappedValue && !manifest.started { loadFiles() }
                    } label: {
                        HStack(spacing: 6) {
                            Text(expanded ? L10n.tr("收起") : L10n.tr("还有 {0} 个文件", count - 4))
                            Spacer(minLength: 0)
                            if manifest.loading { ProgressView().controlSize(.mini) }
                            OrbisActionSymbol(systemName: "chevron.down").imageScale(.small).rotationEffect(.degrees(expanded ? 180 : 0))
                        }.font(.orbisCaption()).foregroundStyle(p.secondary).frame(minHeight: 36).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("turn-changes-expand-" + summary.reviewTurnId)
                }
                if expanded && !manifest.complete && !manifest.loading && (manifest.started || manifest.error != nil) {
                    ChangeHairline()
                    OrbisMotionButton { loadFiles() } label: {
                        Text(manifest.error == nil ? L10n.tr("载入更多文件") : L10n.tr("重新读取文件清单"))
                            .font(.orbisCaption()).foregroundStyle(manifest.error == nil ? p.accent : p.error)
                            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 12).padding(.vertical, 2).neuSurface(inset: true, radius: 14, intensity: 0.35)
            if let note = caveat {
                OrbisStatusWithInfo(title: L10n.tr(summary.coverage != "complete" ? "记录不完整" : summary.reasons.contains(where: { $0.contains("concurrent") }) ? "归属未确认" : "记录范围"), message: note)
                    .padding(.horizontal, 4).accessibilityIdentifier("turn-changes-partial")
            }
        }.padding(.top, 4)
    }

    @ViewBuilder private func header(_ p: OrbisPalette, ready: Bool, count: Int, opens: Bool) -> some View {
        let pending = summary.state == "collecting" || summary.state == "finalizing"
        let title = pending ? L10n.tr("正在统计文件变化") : summary.state == "unavailable" ? L10n.tr("本轮文件变化未记录")
            : count == 0 ? (summary.coverage == "complete" ? L10n.tr("本轮没有文件变化") : L10n.tr("未发现文件变化")) : L10n.tr("{0} 个文件已更改", count)
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
            OrbisMotionButton { open() } label: { row }.buttonStyle(.plain)
                .accessibilityLabel(L10n.tr("查看详情，") + title).accessibilityIdentifier("turn-changes-open-" + summary.reviewTurnId)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    /// One line for what the counts cannot show: incomplete capture or concurrent edits.
    private var caveat: String? {
        turnChangeCoverageNote(summary)
    }
    private func open(fileId: String? = nil) {
        guard ownsTurnChanges(changes, context: context) else { return }
        changes.open(summary, fileId: fileId)
    }
    private func loadFiles() {
        guard ownsTurnChanges(changes, context: context) else { return }
        changes.loadFiles(summary)
    }
}

private struct ChangeHairline: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    var body: some View { Rectangle().fill(OrbisPalette(scheme).secondary.opacity(0.14)).frame(height: 0.5) }
}

/// Git-style status letter; VoiceOver reads the Chinese kind.
private struct ChangeKindLetter: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
    @Environment(\.orbisAppearance) private var visualStyle
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
    private struct Presentation: Identifiable {
        let id: TurnFileChanges.PresentationToken
        let changes: TurnFileChanges
        let context: ChatReadContext
    }
    @ObservedObject var changes: TurnFileChanges
    let context: ChatReadContext
    @State private var presentation: Presentation?
    func body(content: Content) -> some View {
        // The opened version stays until the sheet has left the screen, so closing slides the
        // same file out instead of an empty placeholder. Cleanup belongs to that sheet's
        // immutable item, never to whichever viewer the shared model opens next.
        content.sheet(item: $presentation) { item in
            TurnFileReviewView(changes: item.changes, context: item.context, presentation: item.id).id(item.id)
        }
        .onChange(of: changes.currentPresentation, initial: true) { _, token in
            presentation = token.map { Presentation(id: $0, changes: changes, context: context) }
        }
    }
}

private struct ChangeLineCounts: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
            .accessibilityLabel(additions == nil && deletions == nil ? (status ?? L10n.tr("行数未知"))
                : L10n.tr("新增 {0} 行，删除 {1} 行", additions.map(String.init) ?? L10n.tr("未知"), deletions.map(String.init) ?? L10n.tr("未知")))
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
    let context: ChatReadContext
    let presentation: TurnFileChanges.PresentationToken
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
            if changes.newerVersionAvailable { OrbisStatusWithInfo(title: L10n.tr("有新版本"), message: L10n.tr("本轮概况已更新，当前保持打开时的版本。")).padding(.horizontal, 16) }
            if changes.suspended {
                OrbisActionButton(title: L10n.tr("继续读取"), symbol: "play") {
                    if ownsTurnChanges(changes, context: context) { changes.resume(expected: presentation) }
                }.padding(.horizontal, 16)
            }
            if !files.isEmpty {
                SettledFilePager(changes: changes, context: context, presentation: presentation, files: files, requestedFile: requestedFile, navigation: navigation, reduceMotion: pageReduceMotion)
                    .accessibilityIdentifier("turn-change-pager")
            } else if let summary = changes.opened, let error = changes.manifest(summary).error {
                OrbisNotice(text: error, error: true).padding(.horizontal, 16)
                OrbisActionButton(title: L10n.tr("重新读取文件清单"), symbol: "arrow.clockwise") { loadFiles(summary) }.padding(.horizontal, 16)
                Spacer()
            } else {
                OrbisEmptyState(symbol: "doc", title: L10n.tr("正在读取文件清单")).frame(maxHeight: .infinity)
            }
            HStack {
                OrbisIconButton(symbol: "chevron.left", label: L10n.tr("上一个文件"), size: 44) { request(files[index - 1].fileId) }.disabled(index == 0)
                Spacer()
                Text(files.isEmpty ? L10n.tr("没有文件") : "\(index + 1) / \(changes.opened?.fileCount ?? files.count)")
                    .font(.orbisLabel(.semibold, mono: true)).foregroundStyle(p.secondary).accessibilityIdentifier("turn-change-page")
                Spacer()
                OrbisIconButton(symbol: "chevron.right", label: L10n.tr("下一个文件"), size: 44) { request(files[index + 1].fileId) }.disabled(index + 1 >= files.count)
            }.padding(.horizontal, 20)
            if let summary = changes.opened, index + 1 >= files.count, !changes.manifest(summary).complete, (summary.fileCount ?? 0) > files.count {
                OrbisTextButton(title: L10n.tr("载入更多文件"), symbol: "doc", loading: changes.manifest(summary).loading) { loadFiles(summary) }
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
            .onChange(of: scenePhase) { _, phase in if phase != .active { changes.suspend(expected: presentation) } }
            .onDisappear { changes.closeViewer(expected: presentation) }
    }
    private func header(_ p: OrbisPalette) -> some View {
        VStack(spacing: 0) {
            Capsule().fill(.clear).frame(width: 40, height: 6)
                .neuSurface(inset: true, radius: 3, intensity: 0.35, concentric: false)
                .padding(.top, 7).accessibilityHidden(true)
            OrbisHeader {
                OrbisIconButton(symbol: "xmark", label: L10n.tr("关闭"), action: { if changes.isCurrent(presentation) { dismiss() } })
            } title: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n.tr("本轮文件差异")).font(.orbisTitle()).lineLimit(1).accessibilityAddTraits(.isHeader)
                    if let summary = changes.opened {
                        Text(turnChangeScopeTitle(summary.scope)).font(.orbisCaption()).foregroundStyle(p.secondary).lineLimit(1)
                    }
                }
            } trailing: { EmptyView() }
        }.background(SheetDismissZone())
            .accessibilityElement(children: .contain).accessibilityIdentifier("turn-change-header")
    }
    private func request(_ file: String) {
        guard changes.isCurrent(presentation), ownsTurnChanges(changes, context: context) else { return }
        requestedFile = file; navigation += 1
    }
    private func loadFiles(_ summary: TurnChangeSummary) {
        guard changes.isCurrent(presentation), ownsTurnChanges(changes, context: context) else { return }
        changes.loadFiles(summary)
    }
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
    let context: ChatReadContext
    let presentation: TurnFileChanges.PresentationToken
    let files: [TurnFileMetadata]
    let requestedFile: String?
    let navigation: Int
    let reduceMotion: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIPageViewController {
        let page = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
        page.dataSource = context.coordinator; page.delegate = context.coordinator
        if context.coordinator.isCurrent, let file = files.first(where: { $0.fileId == changes.selectedFileId }) ?? files.first {
            page.setViewControllers([context.coordinator.controller(file)], direction: .forward, animated: false)
        }
        return page
    }
    func updateUIViewController(_ page: UIPageViewController, context: Context) {
        context.coordinator.parent = self
        guard context.coordinator.isCurrent, navigation != context.coordinator.navigation, let target = requestedFile,
              let file = files.first(where: { $0.fileId == target }), !context.coordinator.transitioning else { return }
        context.coordinator.navigation = navigation
        let current = files.firstIndex { $0.fileId == changes.selectedFileId } ?? 0
        let next = files.firstIndex { $0.fileId == target } ?? current
        context.coordinator.transitioning = true
        let transition = UUID()
        context.coordinator.transition = transition
        page.setViewControllers([context.coordinator.controller(file)], direction: next < current ? .reverse : .forward, animated: !reduceMotion) { completed in
            guard context.coordinator.isCurrent, context.coordinator.transition == transition else { return }
            context.coordinator.transition = nil
            context.coordinator.transitioning = false
            if completed { context.coordinator.owner.selectFile(target, expected: context.coordinator.presentation) }
        }
    }
    static func dismantleUIViewController(_ page: UIPageViewController, coordinator: Coordinator) {
        coordinator.retired = true; coordinator.transition = nil
        page.dataSource = nil; page.delegate = nil
    }
    final class Page: UIHostingController<DiffFilePage> {
        let fileId: String
        let presentation: TurnFileChanges.PresentationToken
        init(file: TurnFileMetadata, changes: TurnFileChanges, context: ChatReadContext, presentation: TurnFileChanges.PresentationToken) {
            fileId = file.fileId; self.presentation = presentation
            super.init(rootView: DiffFilePage(changes: changes, context: context, presentation: presentation, file: file)); view.backgroundColor = .clear
        }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    }
    @MainActor final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
        var parent: SettledFilePager
        let owner: TurnFileChanges
        let context: ChatReadContext
        let presentation: TurnFileChanges.PresentationToken
        var navigation = 0
        var transitioning = false
        var transition: UUID?
        var retired = false
        var isCurrent: Bool {
            !retired && parent.changes === owner && parent.presentation == presentation &&
                owner.isCurrent(presentation) && ownsTurnChanges(owner, context: context)
        }
        init(_ parent: SettledFilePager) {
            self.parent = parent; owner = parent.changes; context = parent.context; presentation = parent.presentation
        }
        func controller(_ file: TurnFileMetadata) -> Page { Page(file: file, changes: owner, context: context, presentation: presentation) }
        func pageViewController(_ page: UIPageViewController, viewControllerBefore viewController: UIViewController) -> UIViewController? { adjacent(viewController, delta: -1) }
        func pageViewController(_ page: UIPageViewController, viewControllerAfter viewController: UIViewController) -> UIViewController? { adjacent(viewController, delta: 1) }
        private func adjacent(_ controller: UIViewController, delta: Int) -> UIViewController? {
            guard isCurrent, let current = controller as? Page, current.presentation == presentation,
                  let index = parent.files.firstIndex(where: { $0.fileId == current.fileId }), parent.files.indices.contains(index + delta) else { return nil }
            return self.controller(parent.files[index + delta])
        }
        func pageViewController(_ page: UIPageViewController, willTransitionTo pendingViewControllers: [UIViewController]) {
            guard isCurrent, pendingViewControllers.allSatisfy({ ($0 as? Page)?.presentation == presentation }) else { return }
            transitioning = true
        }
        func pageViewController(_ page: UIPageViewController, didFinishAnimating finished: Bool, previousViewControllers: [UIViewController], transitionCompleted completed: Bool) {
            guard isCurrent else { return }
            transitioning = false
            if completed, let selected = page.viewControllers?.first as? Page, selected.presentation == presentation {
                owner.selectFile(selected.fileId, expected: presentation)
            }
        }
    }
}

private struct DiffFilePage: View {
    @ObservedObject var changes: TurnFileChanges
    let context: ChatReadContext
    let presentation: TurnFileChanges.PresentationToken
    let file: TurnFileMetadata
    @Environment(\.colorScheme) private var scheme
    // Outside the root's environment: follows the settings itself and passes them on (PERF-12).
    @ObservedObject private var display = OrbisDisplaySettings.shared
    @State private var position: Int?
    @State private var restored = false
    @State private var userScrolled = false
    @State private var pageEdgeArmed = true
    var body: some View {
        let detail = changes.detail(for: file)
        let selected = changes.isCurrent(presentation) && changes.selectedFileId == file.fileId
        // Monospaced caption digits are 7.2pt wide; gutters fit the widest number read so far.
        let gutter = CGFloat(detail.parser.gutterDigits) * 7.5
        VStack(alignment: .leading, spacing: 10) {
            DiffFileHeader(file: file)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(detail.lines) { line in DiffLineView(line: line, gutter: gutter).id(line.id) }
                    VStack(spacing: 10) {
                        if let error = detail.error {
                            OrbisNotice(text: error, error: file.detail == "available")
                            if file.detail == "available" && !detail.limitReached { OrbisActionButton(title: L10n.tr("重新读取"), symbol: "arrow.clockwise") { loadNext() }.disabled(!selected || changes.suspended) }
                        } else if detail.loading {
                            ProgressView(L10n.tr("读取差异…")).font(.orbisLabel())
                        } else if detail.eof {
                            Text(detail.lines.isEmpty ? L10n.tr("此文件没有文本差异") : L10n.tr("已显示完整差异")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        } else if selected {
                            OrbisActionButton(title: L10n.tr("继续读取"), symbol: "arrow.down") { loadNext() }.disabled(changes.suspended)
                        } else {
                            Text(L10n.tr("切换到此文件后读取差异")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }.padding(16).frame(maxWidth: .infinity, minHeight: 80)
                        .onAppear {
                            if selected && userScrolled && pageEdgeArmed && detail.nextCursor != nil && detail.error == nil {
                                pageEdgeArmed = false; loadNext()
                            }
                        }.onDisappear { pageEdgeArmed = true }
                }.scrollTargetLayout()
                    .padding(.vertical, 6)
                    .background(DiffScrollObservation { userScrolled = true })
            }.scrollPosition(id: $position, anchor: .top)
                .onAppear { if !restored { position = detail.scrollLine; restored = true } }
                .onChange(of: position) { _, value in if selected && restored { changes.rememberScroll(value, file: file, expected: presentation) } }
                .background(OrbisPalette(scheme).well)
                .clipShape(RoundedRectangle(cornerRadius: OrbisRadius.control, style: .continuous))
                .accessibilityIdentifier("turn-change-diff")
        }.padding(.horizontal, 16)
            .modifier(OrbisDisplayPreferences())
    }
    private func loadNext() {
        guard ownsTurnChanges(changes, context: context), changes.selectedFileId == file.fileId else { return }
        changes.loadNext(expected: presentation)
    }
}

/// Name, kind and counts slide with their page, so a settled swipe never relabels the
/// previous file. Long-press copies the full path.
private struct DiffFileHeader: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
                Text(L10n.tr("原路径：") + old).font(.orbisCaption(mono: true)).foregroundStyle(p.secondary).lineLimit(1).truncationMode(.middle)
            }
        }.padding(.horizontal, 4).padding(.top, 2)
            .contentShape(Rectangle())
            .contextMenu { OrbisMotionButton { UIPasteboard.general.string = file.path } label: { Label(L10n.tr("复制路径"), systemImage: "doc.on.doc") } }
    }
}

private struct ChangeKindBadge: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
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
    @Environment(\.orbisAppearance) private var visualStyle
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
            .accessibilityValue([line.oldLine.map { L10n.tr("旧 {0}", $0) }, line.newLine.map { L10n.tr("新 {0}", $0) }].compactMap { $0 }.joined(separator: L10n.tr("，")))
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
