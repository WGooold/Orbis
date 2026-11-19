import SwiftUI

// MARK: - Markdown


@available(iOS 18.0, *)
private struct RevealRenderer: TextRenderer {
    let clock: RevealClock
    let base: Int
    let now: TimeInterval

    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        let firstIndex = layout.first?.lazy.compactMap { $0.characterIndices.first }.first
        guard let origin = firstIndex else {
            ChatSchedulingTrace.markdownRowDrawn(base: base, settled: true)
            for line in layout { ctx.draw(line) }
            return
        }
        ChatSchedulingTrace.markdownRowDrawn(base: base, settled:
            layout.lazy.flatMap { line in line.lazy.compactMap { run in run.characterIndices.max() } }
                .max().map { base + origin.distance(to: $0) < clock.settledBelow } ?? true)
        let settled = clock.settledBelow
        for line in layout {
            for run in line {
                guard let last = run.characterIndices.max(), base + origin.distance(to: last) >= settled else {
                    ctx.draw(run); continue
                }
                for index in run.indices {
                    let glyph = run[index]
                    guard let character = glyph.characterIndices.first else { ctx.draw(glyph); continue }
                    let progress = clock.progress(base + origin.distance(to: character), at: now)
                    if progress <= 0 { continue }
                    if progress >= 1 { ctx.draw(glyph); continue }
                    var copy = ctx
                    copy.opacity = progress
                    copy.addFilter(.blur(radius: RevealClock.blur * (1 - progress)))
                    copy.draw(glyph)
                }
            }
        }
    }
}

extension Text {
    /// iOS 17 has no text renderer; streamed text simply appears there.
    @ViewBuilder func reveal(_ clock: RevealClock, base: Int, now: TimeInterval) -> some View {
        if #available(iOS 18.0, *) { textRenderer(RevealRenderer(clock: clock, base: base, now: now)) }
        else { self }
    }
}

struct MarkdownMessage: View {
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @Environment(\.chatVisualActivity) private var activity
    @Environment(\.orbisFileActions) private var fileActions
    @Environment(\.downloadFlight) private var downloadFlight
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    private var previewTime = ChatRevealPreviewTime()
    let text: String
    let streaming: Bool
    @State private var clock: RevealClock
    @State private var revealCatchUp = OrbisRevealCatchUp()
    @State private var settleTick = 0
    @StateObject private var preparation: MarkdownPreparation

    // Completed text has no dependency on page phase. Streaming/queued reveal
    // clocks alone observe it, so visibility cannot rebuild static Markdown.
    private var visualActive: Bool {
        guard streaming || clock.isAnimating(at: Date.timeIntervalSinceReferenceDate) || revealCatchUp.hiddenSource != nil else { return true }
        return activity?.active ?? true
    }

    init(text: String, streaming: Bool = false) {
        self.text = text
        self.streaming = streaming
        let cached = MarkdownDocuments.cached(text)
        _preparation = StateObject(wrappedValue: MarkdownPreparation(text: text))
        _clock = State(initialValue: RevealClock(known: cached?.length ?? 0))
    }

    var body: some View {
        let _ = ChatSchedulingTrace.regionBody(.markdown)
        let _ = ChatDebugProbes.rendered(.markdown)
        // Preserve the measured row while a streamed replacement is parsed off-main.
        let cached = MarkdownDocuments.cached(text)
        let prepared = cached ?? preparation.prepared?.document
        let preparedSource = cached != nil ? text : preparation.prepared?.text
        let rows = prepared?.rows ?? []
        let length = prepared?.length ?? 0
        let referenceNow = previewTime.value ?? Date().timeIntervalSinceReferenceDate
        let revealEnabled = streaming && !reduceMotion
        // When the stream ends, characters already queued finish revealing instead of jumping in.
        let animating = visualActive && !reduceMotion && settleTick >= 0 && clock.isAnimating(at: referenceNow)
        let visibleClock = visualActive && (revealEnabled || animating) ? clock : RevealClock(known: length)
        TimelineView(.animation(minimumInterval: nil, paused: !animating)) { context in
            let renderTime = previewTime.value ?? max(context.date.timeIntervalSinceReferenceDate, Date().timeIntervalSinceReferenceDate)
            let now = reduceMotion ? TimeInterval.greatestFiniteMagnitude : renderTime
            VStack(alignment: .leading, spacing: 12) {
                ForEach(rows) { row in rowView(row, html: prepared?.mathHTML[row.id], clock: visibleClock, now: now) }
            }
        }.font(.orbisBody()).textSelection(.enabled)
            .task(id: text) {
                preparation.update(text, streaming: streaming)
            }
            .onDisappear { preparation.cancel() }
            .onChange(of: preparation.prepared?.text) { _, _ in
                guard let prepared, let preparedSource else { return }
                let reveals = revealCatchUp.allowsReveal(preparedSource: preparedSource, currentSource: text, active: visualActive)
                if reveals && revealEnabled { clock.observe(length: prepared.length, at: referenceNow) }
                else { clock = RevealClock(known: prepared.length) }
            }
            .environment(\.openURL, OpenURLAction { url in
                let scheme = url.scheme?.lowercased() ?? ""
                if ["http", "https", "mailto"].contains(scheme) { return .systemAction }
                let path = url.isFileURL ? url.path : url.absoluteString.removingPercentEncoding ?? url.absoluteString
                if messageFileReferenceId(path) == nil && !url.isFileURL &&
                    path.range(of: #"^(?:/(?!/)|[A-Za-z]:[\\/])"#, options: .regularExpression) == nil { return .discarded }
                if fileActions?.download(path: path) == true { downloadFlight?.launch() }
                return .handled
            })
            .onChange(of: text) { previous, value in
                revealCatchUp.sourceChanged(value, active: visualActive)
                let reveals = revealCatchUp.allowsReveal(preparedSource: preparedSource, currentSource: value, active: visualActive)
                if reveals && revealEnabled && value.hasPrefix(previous) { clock.observe(length: length, at: referenceNow) }
                else { clock = RevealClock(known: length) }
            }
            // Starting to stream takes the current text as the baseline; ending lets the queue drain.
            .onChange(of: revealEnabled) { _, enabled in
                preparation.update(text, streaming: streaming)
                if enabled { clock = RevealClock(known: length) }
            }
            // Hidden updates become the new baseline. Returning never replays
            // an old stream, and the same renderer/editor subtree stays mounted.
            .onChange(of: visualActive, initial: true) { _, active in
                revealCatchUp.visibilityChanged(active: active, source: text, preparedSource: preparedSource)
                clock = RevealClock(known: length)
            }
            .task(id: clock.end) {
                // Pause the timeline once the last character has settled.
                let wait = clock.end - Date().timeIntervalSinceReferenceDate
                guard visualActive, wait > 0 else { return }
                do { try await Task.sleep(nanoseconds: UInt64((wait + 0.05) * 1_000_000_000)) } catch { return }
                guard visualActive, !Task.isCancelled else { return }
                settleTick += 1
            }
    }

    @ViewBuilder private func rowView(_ row: MarkdownRow, html: String?, clock: RevealClock, now: TimeInterval) -> some View {
        let p = OrbisPalette(scheme)
        switch row.kind {
        case .spacer: Spacer().frame(height: 2)
        case .divider: Rectangle().fill(p.outline).frame(height: 1)
        case .image(let alt, let url): MarkdownImageView(alt: alt, url: url)
        case .table(let section): MarkdownTableView(section: section)
        case .code(let language, let code): CodeBlockView(text: code, language: language, clock: clock, base: row.base, now: now)
        case .quote(let value):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(p.accent.opacity(0.6)).frame(width: 3)
                mathOrText(value, html: html, clock: clock, base: row.base, now: now, color: p.secondary)
                    .foregroundStyle(p.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }.fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let value):
            mathOrText(value, html: html, clock: clock, base: row.base, now: now, size: level <= 2 ? OrbisTextSize.title : OrbisTextSize.body, bold: true)
                .font(level <= 2 ? .orbisTitle() : .orbisBody(.semibold))
                .padding(.top, 4).accessibilityAddTraits(.isHeader)
        case .task(let checked, let value):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                OrbisActionSymbol(systemName: checked ? "checkmark.square.fill" : "square").orbisIconBaseline(OrbisTextSize.body)
                mathOrText(value, html: html, clock: clock, base: row.base, now: now)
            }
        case .bullet(let indent, let value):
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Text("•").reveal(clock, base: row.base, now: now)
                mathOrText(value, html: html, clock: clock, base: row.base + 1, now: now)
            }.padding(.leading, CGFloat(min(indent, 12)) * 6)
        case .text(let value):
            mathOrText(value, html: html, clock: clock, base: row.base, now: now)
        }
    }
    @ViewBuilder private func mathOrText(_ value: AttributedString, html: String?, clock: RevealClock, base: Int, now: TimeInterval,
        size: CGFloat = OrbisTextSize.body, bold: Bool = false, color: Color? = nil) -> some View {
        if let html {
            MathFragment(html: html, source: value, size: size, bold: bold, color: color ?? OrbisPalette(scheme).text,
                clock: clock, base: base, now: now)
        } else { Text(value).reveal(clock, base: base, now: now) }
    }
}

private struct CodeBlockView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let text: String
    let language: String
    let clock: RevealClock
    let base: Int
    let now: TimeInterval
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(language).font(.orbisCaption(mono: true)).foregroundStyle(OrbisPalette(scheme).secondary)
                Spacer()
                OrbisCopyButton(label: L10n.tr("复制代码"), size: 28) { text }
            }.padding(.top, -6).padding(.trailing, -8)
            ScrollView(.horizontal) {
                Text(text).reveal(clock, base: base, now: now)
                    .font(.orbisLabel(mono: true)).fixedSize(horizontal: true, vertical: false).textSelection(.enabled).padding(.bottom, 4)
            }.accessibilityIdentifier("chat-code-horizontal")
        }.neuSurface(inset: true, radius: 12, intensity: 0.4, padding: 12)
    }
}

private struct MarkdownTableView: View {
    @Environment(\.colorScheme) private var scheme
    let section: MarkdownTextSection
    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(section.rows.enumerated()), id: \.offset) { rowIndex, row in
                    GridRow(alignment: .top) {
                        ForEach(Array((section.rows.first ?? []).indices), id: \.self) { column in
                            cell(row: rowIndex, column: column)
                                .font(.orbisLabel(rowIndex == 0 ? .semibold : .regular))
                                .frame(width: 150, alignment: alignment(column)).padding(10)
                                .frame(maxHeight: .infinity, alignment: .top)
                                // Rows separate by a lightness step, not by drawn grid lines.
                                .background(OrbisLayerFill(offset: 1, opacity: rowIndex == 0 ? 1 : rowIndex % 2 == 0 ? 0.5 : 0))
                        }
                    }
                }
            }
        }.accessibilityIdentifier("chat-table-horizontal")
            .neuSurface(inset: true, radius: 12, intensity: 0.4).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous)).textSelection(.enabled)
    }
    @ViewBuilder private func cell(row: Int, column: Int) -> some View {
        let value = row < section.inlineRows.count && column < section.inlineRows[row].count ? section.inlineRows[row][column] : AttributedString("")
        if row < section.mathRows.count, column < section.mathRows[row].count, let html = section.mathRows[row][column] {
            MathFragment(html: html, source: value, size: OrbisTextSize.label, bold: row == 0, color: OrbisPalette(scheme).text,
                alignment: alignment(column) == .center ? "center" : alignment(column) == .trailing ? "right" : "left")
        } else { Text(value) }
    }
    private func alignment(_ column: Int) -> Alignment {
        let markers = section.text.components(separatedBy: "|")
        guard column < markers.count else { return .leading }
        let marker = markers[column]
        if marker.hasPrefix(":") && marker.hasSuffix(":") { return .center }
        return marker.hasSuffix(":") ? .trailing : .leading
    }
}

private struct MarkdownImageView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    let alt: String
    let url: URL
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AsyncImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFit().frame(maxHeight: 280).accessibilityLabel(alt.isEmpty ? L10n.tr("消息图片") : alt) }
                else if phase.error != nil { Label(alt.isEmpty ? L10n.tr("图片未能加载") : alt, systemImage: "photo").font(.orbisLabel()) }
                else { ProgressView().frame(maxWidth: .infinity, minHeight: 80) }
            }
            Link(alt.isEmpty ? L10n.tr("打开图片") : alt, destination: url).font(.orbisCaption())
        }.neuSurface(inset: true, radius: 12, intensity: 0.4, padding: 12)
    }
}
