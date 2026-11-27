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
/// FILE-PREVIEW-03: tapping the file opens its preview in place; the trailing button saves the original.
struct ChatFilePreviewCard: View {
    let preview: ChatFilePreview
    let key: ChatFilePreview.Key
    let label: String
    let downloadIdentifier: String
    let canOpen: () -> Bool
    let download: () -> Void
    @Environment(\.openChatFilePreview) private var showPage
    @Environment(\.chatVisualActivity) private var activity
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @State private var selection: ChatFilePreview.Selection?
    @State private var available = true
    @State private var panelVisible = false

    private var format: ChatFilePreview.Format? { .init(fileName: key.name) }

    var body: some View {
        let p = OrbisPalette(scheme)
        VStack(alignment: .leading, spacing: 8) {
            if available || selection != nil {
                HStack(spacing: 6) {
                    OrbisMotionButton(action: toggle) {
                        HStack(spacing: 8) {
                            OrbisActionSymbol(systemName: format?.symbol ?? "doc")
                            FileNameText(name: label)
                            Spacer(minLength: 4)
                            if let size = preview.knownSize(key.source) {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                                    .font(.orbisCaption(mono: true)).foregroundStyle(p.faint).lineLimit(1).fixedSize()
                            }
                            Image(systemName: "chevron.down").font(.orbisCaption(.semibold)).foregroundStyle(p.faint)
                                .rotationEffect(.degrees(selection == nil ? 0 : 180))
                        }.font(.orbisLabel()).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                    }
                    .buttonStyle(NeuButtonStyle(selected: selection != nil))
                    .accessibilityLabel(selection == nil ? L10n.tr("预览 {0}", label) : L10n.tr("收起 {0}", label))
                    .accessibilityIdentifier(selection == nil ? "chat-file-preview-open" : "chat-file-preview-close")
                    OrbisIconButton(symbol: "arrow.down.to.line", label: L10n.tr("下载原文件"), compact: true, action: download)
                        .accessibilityIdentifier(downloadIdentifier)
                }
            } else {
                // The connected Host has no preview path for this type: the card is the ordinary download.
                OrbisMotionButton(action: download) {
                    HStack(spacing: 8) {
                        OrbisActionSymbol(systemName: "arrow.down.doc")
                        FileNameText(name: label)
                    }.font(.orbisLabel()).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                }.buttonStyle(NeuButtonStyle()).accessibilityIdentifier(downloadIdentifier)
            }
            if let selection, !(selection.phase == .ready && format == .mp4) { panel(selection, palette: p) }
        }
        .background {
            if let selection, selection.phase == .loading {
                PreviewViewportReader { visible in if !visible { preview.fileHidden(key, id: selection.id) } }
            }
        }
        .onReceive(preview.availability) { value in
            available = format.map { $0.isWeb ? value.web : value.native } ?? false
        }
        .onReceive(preview.changes.map { $0?.key == key ? $0 : nil }.removeDuplicates()) { next in
            let openingVideo = selection?.id == next?.id && selection?.phase == .loading && next?.phase == .ready &&
                next?.fullScreen == true && format == .mp4
            selection = next
            if openingVideo, let next {
                if canOpen(), activity?.active != false, scenePhase == .active, let showPage { showPage(next.id) }
                else { _ = preview.setFullScreen(next.id, false) }
            }
        }
        .onDisappear { if let selection { preview.fileHidden(key, id: selection.id) } }
    }

    private func toggle() {
        if selection != nil { preview.close(key: key) }
        else if canOpen() { preview.open(key) }
    }

    private func openFullScreen(_ selection: ChatFilePreview.Selection) {
        if canOpen(), let showPage, preview.setFullScreen(selection.id, true) { showPage(selection.id) }
    }

    @ViewBuilder private func panel(_ selection: ChatFilePreview.Selection, palette p: OrbisPalette) -> some View {
        let shape = RoundedRectangle(cornerRadius: OrbisRadius.control, style: .continuous)
        ZStack {
            switch selection.phase {
            case .loading:
                VStack(spacing: 10) {
                    if let progress = selection.progress, progress.total > 0 {
                        ProgressView(value: Double(progress.received), total: Double(progress.total))
                            .progressViewStyle(.linear).tint(p.accent).frame(maxWidth: 180)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(progress.received), countStyle: .file) + " / " +
                             ByteCountFormatter.string(fromByteCount: Int64(progress.total), countStyle: .file))
                            .font(.orbisCaption(mono: true)).foregroundStyle(p.faint)
                    } else { ProgressView() }
                }
                .accessibilityElement(children: .ignore).accessibilityLabel(L10n.tr("正在加载预览"))
                .accessibilityIdentifier("chat-file-preview-loading")
            case .failed(let failure):
                VStack(spacing: 8) {
                    Image(systemName: failure.symbol).font(.title3).foregroundStyle(p.faint)
                    Text(failure.label(format)).font(.orbisLabel()).foregroundStyle(p.secondary).multilineTextAlignment(.center)
                    if failure == .interrupted {
                        OrbisTextButton(title: L10n.tr("重试"), symbol: "arrow.clockwise") { if canOpen() { preview.open(key) } }
                    }
                }.padding(16)
            case .ready:
                if let snapshot = selection.snapshot {
                    GeometryReader { geometry in
                        Image(decorative: snapshot, scale: 1).resizable().aspectRatio(contentMode: .fill)
                            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top).clipped()
                    }.accessibilityIdentifier("chat-file-preview-snapshot")
                } else if panelVisible, !selection.fullScreen, activity?.active != false, scenePhase == .active {
                    ChatFileReader(preview: preview, selection: selection, fullScreen: false).allowsHitTesting(false)
                } else { Color.clear }
            }
        }
        // FILE-PREVIEW-05: one surface for loading, rendering and the result; a page is white only once it has painted.
        .frame(maxWidth: .infinity).frame(height: 240)
        .background(p.well)
        .clipShape(shape)
        .overlay(shape.strokeBorder(p.outline, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            if selection.phase == .ready, showPage != nil {
                Image(systemName: "arrow.up.left.and.arrow.down.right").font(.orbisCaption(.semibold)).foregroundStyle(p.secondary)
                    .frame(width: 30, height: 30).background(.regularMaterial, in: Circle()).padding(8)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(shape)
        .onTapGesture { if selection.phase == .ready { openFullScreen(selection) } }
        .accessibilityElement(children: selection.phase == .ready ? .ignore : .contain)
        .accessibilityLabel(selection.phase == .ready ? L10n.tr("全屏预览") : "")
        .accessibilityAddTraits(selection.phase == .ready ? .isButton : [])
        .background { PreviewViewportReader { visible in if panelVisible != visible { panelVisible = visible } } }
        .accessibilityIdentifier(selection.phase == .ready ? "chat-file-preview-fullscreen" : "chat-file-preview-panel")
    }
}

private extension ChatFilePreview.Format {
    var symbol: String {
        switch self {
        case .html: "globe"
        case .svg, .jpeg, .png: "photo"
        case .pdf: "doc.richtext"
        case .text: "doc.plaintext"
        case .markdown: "doc.richtext"
        case .mp4: "play.rectangle"
        }
    }
}

private extension ChatFilePreview.Failure {
    var symbol: String {
        switch self {
        case .unavailable: "questionmark.folder"
        case .unsupported: "eye.slash"
        case .tooLarge: "arrow.down.doc"
        case .interrupted: "wifi.exclamationmark"
        }
    }
    func label(_ format: ChatFilePreview.Format?) -> String {
        switch self {
        case .unavailable: L10n.tr("预览不可用")
        case .unsupported: L10n.tr("此文件无法预览")
        case .tooLarge: format.map { L10n.tr("超过预览上限 {0}", ByteCountFormatter.string(fromByteCount: Int64($0.budget), countStyle: .file)) }
            ?? L10n.tr("文件过大，无法预览")
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
        if let format = ChatFilePreview.Format(fileName: selection.key.name) {
            if format.isWeb {
                if selection.entry != nil { ChatFileBrowser(preview: preview, selection: selection, fullScreen: fullScreen) }
            } else if let data = selection.document {
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
    @Environment(\.orbisReduceMotion) private var reduceMotion
    @State private var policy: WKContentRuleList?
    @State private var painted = false
    private var ownsDocument: Bool {
        preview.current?.id == selection.id && preview.current?.phase == .ready &&
            preview.current?.fullScreen == fullScreen
    }
    var body: some View {
        ZStack {
            if let policy, let entry = selection.entry {
                PreviewWebSurface(page: selection.id, entry: entry, resources: { [preview, id = selection.id] path, done in
                        preview.resource(id, path: path) { done(try? $0.get()) }
                    }, policy: policy, interactive: fullScreen,
                    admitted: { ownsDocument }, painted: { painted = true },
                    captured: { image in if ownsDocument { preview.setSnapshot(selection.id, image) } },
                    failed: { if ownsDocument { preview.renderFailed(selection.id) } })
                    .opacity(painted ? 1 : 0)
            }
            if !painted { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
        }
        // An interactive page keeps its horizontal drags; page back starts from the leading edge.
        .orbisContentOwnsHorizontalDrag(fullScreen)
        // The WebView's white canvas stays behind the reader surface until the page paints, then fades in.
        .animation(reduceMotion ? nil : InteractionMotion.panel, value: painted)
        .task {
            do {
                let compiled = try await PreviewWebSurface.compilePolicy()
                if !Task.isCancelled, ownsDocument { policy = compiled }
            } catch { if !Task.isCancelled, ownsDocument { preview.renderFailed(selection.id) } }
        }
    }
}

/// FILE-PREVIEW-03. The original page in an offline WebView: scripts run, but nothing reaches a network,
/// the App, another page or persistent storage. Every load goes through `PreviewResourceHandler`.
struct PreviewWebSurface: UIViewRepresentable {
    static let scheme = "orbis-web-preview"
    /// Blocks every load except this preview's own scheme and inline data. WebKit rejects an invalid list
    /// (its patterns have no alternation); never fall back to a less restricted reader.
    static func compilePolicy() async throws -> WKContentRuleList {
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^orbis-web-preview://[a-f0-9-]+/"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}}]"#
        guard let policy = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "orbis-web-preview-v3", encodedContentRuleList: rules) else {
            throw URLError(.resourceUnavailable)
        }
        return policy
    }
    /// Peer-to-peer media could reach the network outside resource loading; remove it before page scripts run.
    static let guardScript = """
        (() => {
          const remove = (target, name) => { try { Object.defineProperty(target, name, { value: undefined, configurable: false, writable: false }); } catch (_) {} };
          for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "RTCRtpSender", "RTCRtpReceiver"]) remove(window, name);
          remove(Navigator.prototype, "mediaDevices");
          remove(Navigator.prototype, "sendBeacon");
        })();
        """

    /// One open page; its id names the private origin.
    let page: UUID
    let entry: ChatFilePreview.WebResource
    /// Answers a decoded path below the page's site root, on the main actor; `nil` is a 404.
    let resources: PreviewResourceHandler.Resolve
    let policy: WKContentRuleList
    let interactive: Bool
    let admitted: () -> Bool
    let painted: () -> Void
    let captured: (CGImage) -> Void
    let failed: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIView { UIView() }
    func updateUIView(_ view: UIView, context: Context) {
        let owner = context.coordinator
        owner.painted = painted; owner.captured = captured; owner.failed = failed
        guard admitted(), owner.webView == nil else { return }
        Coordinator.active?.dispose() // SwiftUI can make the destination before dismantling the source.
        Coordinator.active = owner
        let origin = page.uuidString.lowercased()
        let path = entry.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? entry.path
        guard let url = URL(string: "\(Self.scheme)://\(origin)/\(path)") else { failed(); return }
        let handler = PreviewResourceHandler(page: origin, resolve: resources)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.dataDetectorTypes = []
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.userContentController.add(policy)
        configuration.userContentController.addUserScript(WKUserScript(source: Self.guardScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        configuration.setURLSchemeHandler(handler, forURLScheme: Self.scheme)
        let browser = WKWebView(frame: view.bounds, configuration: configuration)
        browser.translatesAutoresizingMaskIntoConstraints = false
        browser.navigationDelegate = owner
        browser.uiDelegate = owner
        browser.allowsLinkPreview = false
        browser.isUserInteractionEnabled = interactive
        browser.scrollView.isScrollEnabled = interactive
        browser.scrollView.contentInsetAdjustmentBehavior = .never
        owner.webView = browser; owner.handler = handler; owner.entryURL = url; owner.interactive = interactive
        view.addSubview(browser)
        NSLayoutConstraint.activate([browser.topAnchor.constraint(equalTo: view.topAnchor), browser.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            browser.leadingAnchor.constraint(equalTo: view.leadingAnchor), browser.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        browser.load(URLRequest(url: url))
        // A page whose files are slow still gets a card image.
        if !interactive { owner.capture(after: .seconds(12)) }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.dispose() }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        static weak var active: Coordinator?
        var webView: WKWebView?
        var handler: PreviewResourceHandler?
        var entryURL: URL?
        var interactive = false
        var painted: (() -> Void)?
        var captured: ((CGImage) -> Void)?
        var failed: (() -> Void)?
        private var started = false
        private var pending: Task<Void, Never>?

        func dispose() {
            if Self.active === self { Self.active = nil }
            pending?.cancel(); pending = nil
            handler?.invalidate(); handler = nil
            webView?.navigationDelegate = nil; webView?.uiDelegate = nil
            webView?.stopLoading(); webView?.removeFromSuperview(); webView = nil; entryURL = nil
        }
        func capture(after delay: Duration) {
            pending?.cancel()
            pending = Task { [weak self] in
                do { try await Task.sleep(for: delay) } catch { return }
                guard let self, let webView = self.webView, !self.interactive else { return }
                let configuration = WKSnapshotConfiguration()
                configuration.afterScreenUpdates = true
                guard let image = try? await webView.takeSnapshot(configuration: configuration), let still = image.cgImage,
                      self.webView === webView else { return }
                self.captured?(still)
            }
        }
        private func document(_ url: URL?) -> String? { url.map { $0.absoluteString.split(separator: "#", maxSplits: 1).first.map(String.init) ?? "" } }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, let entryURL else { decisionHandler(.cancel); return }
            if action.targetFrame?.isMainFrame == true {
                // The entry once; afterwards only jumps within it. Links never leave the preview.
                let allow = started ? document(url) == document(entryURL) : url == entryURL
                started = true
                decisionHandler(allow ? .allow : .cancel)
            } else {
                let own = url.scheme == PreviewWebSurface.scheme && url.host == entryURL.host
                decisionHandler(own || ["about", "data", "blob"].contains(url.scheme ?? "") ? .allow : .cancel)
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType ? .allow : .cancel) // never hand a file to a download
        }
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { if interactive { painted?() } }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            painted?()
            // Let scripts and web fonts settle before the still image replaces the live view.
            if !interactive { capture(after: .milliseconds(600)) }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed?() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed?() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed?() }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) { completionHandler() }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
        func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
        func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
                     completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) { completionHandler(nil) }
    }
}

/// Answers the page's requests through its provider: in chat, the entry, verified files already fetched, or a new
/// bounded fetch from the Host; on the downloads page, only the saved file. Anything else is a plain 404.
final class PreviewResourceHandler: NSObject, WKURLSchemeHandler {
    typealias Resolve = @MainActor (String, @escaping (ChatFilePreview.WebResource?) -> Void) -> Void
    /// The page may load its own files, inline its scripts and styles, and use `data:`/`blob:`; nothing else.
    static let policy = "default-src orbis-web-preview: data: blob:; script-src orbis-web-preview: 'unsafe-inline' 'unsafe-eval' data: blob:; " +
        "style-src orbis-web-preview: 'unsafe-inline' data: blob:; img-src orbis-web-preview: data: blob:; font-src orbis-web-preview: data:; " +
        "media-src orbis-web-preview: data: blob:; connect-src orbis-web-preview: data: blob:; worker-src orbis-web-preview: blob:; " +
        "frame-src orbis-web-preview: data: blob: about:; form-action 'none'; base-uri orbis-web-preview:"
    private let page: String
    private let resolve: Resolve
    private var tasks = Set<ObjectIdentifier>()
    private var valid = true

    init(page: String, resolve: @escaping Resolve) {
        self.page = page; self.resolve = resolve
    }
    func invalidate() { valid = false; tasks = [] }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        MainActor.assumeIsolated { begin(task) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        tasks.remove(ObjectIdentifier(task as AnyObject))
    }

    @MainActor private func begin(_ task: WKURLSchemeTask) {
        let token = ObjectIdentifier(task as AnyObject)
        tasks.insert(token)
        guard valid, let url = task.request.url, url.scheme == PreviewWebSurface.scheme, url.host?.lowercased() == page,
              (task.request.httpMethod ?? "GET") == "GET" else { respond(task, token: token, url: task.request.url, nil); return }
        resolve(url.path) { [weak self] resource in self?.respond(task, token: token, url: url, resource) }
    }

    private func respond(_ task: WKURLSchemeTask, token: ObjectIdentifier, url: URL?, _ resource: ChatFilePreview.WebResource?) {
        // WebKit raises if a stopped task receives anything.
        guard valid, tasks.remove(token) != nil, let url else { return }
        var headers = ["Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-DNS-Prefetch-Control": "off"]
        let body = resource?.body ?? Data()
        if let resource {
            headers["Content-Type"] = resource.mimeType
            headers["Content-Length"] = String(body.count)
            if resource.mimeType.hasPrefix("text/html") || resource.mimeType.hasPrefix("image/svg+xml") { headers["Content-Security-Policy"] = Self.policy }
        } else { headers["Content-Type"] = "text/plain; charset=utf-8"; headers["Content-Length"] = "0" }
        guard let response = HTTPURLResponse(url: url, statusCode: resource == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse)); return
        }
        task.didReceive(response)
        if !body.isEmpty { task.didReceive(body) }
        task.didFinish()
    }
}
