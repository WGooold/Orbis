import SwiftUI
import WebKit

private struct OpenChatFilePreviewKey: EnvironmentKey {
    static let defaultValue: ((UUID) -> Void)? = nil
}
extension EnvironmentValues {
    var openChatFilePreview: ((UUID) -> Void)? {
        get { self[OpenChatFilePreviewKey.self] }
        set { self[OpenChatFilePreviewKey.self] = newValue }
    }
}

/// A subscriber at the file card, not at the transcript or its data source.
struct ChatFilePreviewCard<Download: View>: View {
    let preview: ChatFilePreview
    let key: ChatFilePreview.Key
    let canOpen: () -> Bool
    @ViewBuilder let download: () -> Download
    @Environment(\.openChatFilePreview) private var showPage
    @Environment(\.chatVisualActivity) private var activity
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: ChatFilePreview.Selection?
    @State private var panelVisible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                download()
                if let selection {
                    if selection.phase == .ready, let showPage {
                        OrbisIconButton(symbol: "arrow.up.left.and.arrow.down.right", label: L10n.tr("全屏预览")) {
                            if canOpen(), preview.setFullScreen(selection.id, true) { showPage(selection.id) }
                        }.accessibilityIdentifier("chat-file-preview-fullscreen")
                    }
                    OrbisIconButton(symbol: "chevron.up", label: L10n.tr("收起")) { preview.close(key: key) }
                        .accessibilityIdentifier("chat-file-preview-close")
                } else {
                    OrbisTextButton(title: L10n.tr("预览"), symbol: "eye") {
                        if canOpen() { preview.open(key) }
                    }.accessibilityIdentifier("chat-file-preview-open")
                }
            }
            if let selection, !(selection.phase == .ready && ChatFilePreview.Format(fileName: key.name) == .mp4) {
                Group {
                    switch selection.phase {
                    case .loading: ProgressView().accessibilityLabel(L10n.tr("正在加载预览"))
                    case .failed(let failure):
                        VStack(spacing: 8) {
                            Text(failure.label).font(.orbisLabel())
                            if failure == .interrupted {
                                OrbisTextButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { if canOpen() { preview.open(key) } }
                            }
                        }
                    case .ready:
                        if panelVisible, !selection.fullScreen, activity?.active != false, scenePhase == .active {
                            ChatFileReader(preview: preview, selection: selection, fullScreen: false)
                                .allowsHitTesting(false)
                        } else { Color.clear }
                    }
                }
                .frame(maxWidth: .infinity).frame(height: 240)
                .clipped()
                .background {
                    PreviewViewportReader { visible in if panelVisible != visible { panelVisible = visible } }
                }
                .accessibilityIdentifier("chat-file-preview-panel")
            }
        }
        .background {
            if let selection, selection.phase == .loading {
                PreviewViewportReader { visible in if !visible { preview.fileHidden(key, id: selection.id) } }
            }
        }
        .onReceive(preview.changes.map { $0?.key == key ? $0 : nil }.removeDuplicates()) { next in
            let openingVideo = selection?.id == next?.id && selection?.phase == .loading && next?.phase == .ready &&
                next?.fullScreen == true && ChatFilePreview.Format(fileName: key.name) == .mp4
            selection = next
            if openingVideo, let next {
                if canOpen(), activity?.active != false, scenePhase == .active, let showPage { showPage(next.id) }
                else { _ = preview.setFullScreen(next.id, false) }
            }
        }
        .onDisappear { if let selection { preview.fileHidden(key, id: selection.id) } }
    }
}

private extension ChatFilePreview.Failure {
    var label: String {
        switch self {
        case .unavailable: L10n.tr("预览不可用")
        case .unsupported: L10n.tr("此文件无法预览")
        case .tooLarge: L10n.tr("文件过大，无法预览")
        case .interrupted: L10n.tr("预览已中断")
        }
    }
}

/// Native transcript calls these small readers after scrolling, layout and reuse.
private struct PreviewViewportReader: UIViewRepresentable {
    @Environment(\.chatNativeCellGeometry) private var geometry
    let onVisibility: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.isUserInteractionEnabled = false; view.isAccessibilityElement = false
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        let owner = context.coordinator
        if owner.geometry !== geometry {
            owner.geometry?.unregister(id: owner.id); owner.geometry = geometry
        }
        geometry?.register(id: owner.id, view: view, includeClipping: true) { [weak view] frame in
            guard view?.window != nil, let frame else { onVisibility(false); return }
            onVisibility(!frame.isNull && !frame.isEmpty)
        }
        // This entry is installed in the native transcript; fail closed outside its viewport owner.
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.geometry?.unregister(id: coordinator.id)
    }
    @MainActor final class Coordinator {
        let id = UUID()
        weak var geometry: ChatNativeCellGeometry?
    }
}

struct ChatFilePreviewPage: View {
    let preview: ChatFilePreview
    let id: UUID
    let back: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.orbisPageActivity) private var activity
    @State private var selection: ChatFilePreview.Selection?

    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: selection?.key.name ?? L10n.tr("预览"), back: back) { EmptyView() }
            if let selection, scenePhase == .active, activity.isTop {
                ChatFileReader(preview: preview, selection: selection, fullScreen: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("chat-file-preview-reader")
            }
        }
        .onReceive(preview.changes.map { $0?.id == id && $0?.fullScreen == true ? $0 : nil }.removeDuplicates()) { next in
            selection = next
            if next == nil { returnToCardIfEnded() }
        }
        .onChange(of: activity.isTop) { _, _ in returnToCardIfEnded() }
        .onDisappear { _ = preview.setFullScreen(id, false) }
    }

    private func returnToCardIfEnded() {
        // A renderer failure leaves the selection (and the download button) on the card.
        if activity.isTop, preview.current?.id != id || preview.current?.fullScreen != true { back() }
    }
}

private struct ChatFileReader: View {
    let preview: ChatFilePreview
    let selection: ChatFilePreview.Selection
    let fullScreen: Bool
    var body: some View {
        if let format = ChatFilePreview.Format(fileName: selection.key.name), let data = selection.document {
            if format.isWeb { ChatFileBrowser(preview: preview, selection: selection, fullScreen: fullScreen) }
            else {
                NativeFileReader(source: .snapshot(data), format: format, fullScreen: fullScreen) {
                    if preview.current?.id == selection.id, preview.current?.fullScreen == fullScreen { preview.renderFailed(selection.id) }
                }.id(selection.id)
            }
        }
    }
}

private struct ChatFileBrowser: View {
    let preview: ChatFilePreview
    let selection: ChatFilePreview.Selection
    let fullScreen: Bool
    @State private var policy: WKContentRuleList?
    @State private var loaded = false
    private var ownsDocument: Bool {
        preview.current?.id == selection.id && preview.current?.phase == .ready &&
            preview.current?.fullScreen == fullScreen
    }
    var body: some View {
        ZStack {
            if !loaded { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
            if let policy, let document = selection.document {
                PreviewWebSurface(id: selection.id, document: document, policy: policy, fullScreen: fullScreen,
                    admitted: { ownsDocument }, loaded: { loaded = true }, failed: { if ownsDocument { preview.renderFailed(selection.id) } })
                    .opacity(loaded ? 1 : 0)
            }
        }
        .task {
            do {
                let compiled = try await PreviewWebSurface.compilePolicy()
                if !Task.isCancelled, ownsDocument { policy = compiled }
            } catch { if !Task.isCancelled, ownsDocument { preview.renderFailed(selection.id) } }
        }
        .task {
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            if !loaded, ownsDocument { preview.renderFailed(selection.id) }
        }
    }
}

/// Isolated memory-only entry. Never give WebKit a real path or an App resource origin.
struct PreviewWebSurface: UIViewRepresentable {
    // WebKit rejects an invalid rule list. Do not instantiate a less restricted reader.
    static func compilePolicy() async throws -> WKContentRuleList {
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^orbis-file-preview://document/[a-f0-9-]+$"},"action":{"type":"ignore-previous-rules"}}]"#
        guard let policy = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "orbis-static-preview-v1", encodedContentRuleList: rules) else {
            throw URLError(.resourceUnavailable)
        }
        return policy
    }

    let id: UUID
    let document: Data
    let policy: WKContentRuleList
    let fullScreen: Bool
    let admitted: () -> Bool
    let loaded: () -> Void
    let failed: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIView { UIView() }
    func updateUIView(_ view: UIView, context: Context) {
        let owner = context.coordinator
        owner.loaded = loaded; owner.failed = failed
        guard admitted(), owner.webView == nil else { return }
        Coordinator.active?.dispose() // SwiftUI can make the destination before dismantling the source.
        Coordinator.active = owner
        let entry = URL(string: "orbis-file-preview://document/" + id.uuidString.lowercased())!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        configuration.userContentController.add(policy)
        configuration.setURLSchemeHandler(PreviewDocumentHandler(url: entry, document: document), forURLScheme: entry.scheme!)
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.translatesAutoresizingMaskIntoConstraints = false
        browser.navigationDelegate = owner
        browser.allowsLinkPreview = false
        browser.scrollView.isScrollEnabled = fullScreen
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        owner.webView = browser; owner.initialURL = entry
        view.addSubview(browser)
        NSLayoutConstraint.activate([browser.topAnchor.constraint(equalTo: view.topAnchor), browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor), browser.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        browser.load(URLRequest(url: entry))
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.dispose() }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        static weak var active: Coordinator?
        var webView: WKWebView?
        var initialURL: URL?
        var loaded: (() -> Void)?
        var failed: (() -> Void)?
        func dispose() {
            if Self.active === self { Self.active = nil }
            webView?.navigationDelegate = nil
            webView?.stopLoading(); webView?.removeFromSuperview(); webView = nil; initialURL = nil
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allow = action.targetFrame?.isMainFrame == true && initialURL != nil && action.request.url == initialURL
            if allow { initialURL = nil }
            decisionHandler(allow ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed?() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed?() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed?() }
    }
}

private final class PreviewDocumentHandler: NSObject, WKURLSchemeHandler {
    let url: URL
    let document: Data
    init(url: URL, document: Data) { self.url = url; self.document = document }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.url == url, task.request.httpMethod == "GET",
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [
                "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
              ]) else { task.didFailWithError(URLError(.resourceUnavailable)); return }
        task.didReceive(response); task.didReceive(document); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
