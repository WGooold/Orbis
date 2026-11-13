import SwiftUI
import WebKit

/// A local math-bearing paragraph/cell. Prose elsewhere keeps native Text rendering.
struct MathFragment: View {
    let html: String
    let source: AttributedString
    var size: CGFloat = OrbisTextSize.body
    var bold = false
    var color: Color
    var alignment = "left"
    var clock = RevealClock(known: 0)
    var base = 0
    var now: TimeInterval = .greatestFiniteMagnitude
    @Environment(\.openURL) private var openURL
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    @State private var content: MathWebContent?
    @State private var revision = ""
    @State private var height: CGFloat = 1
    @State private var rendered = false

    var body: some View {
        let settings = MathWebSettings(html: html, size: size * scale, bold: bold,
            color: color.mathCSS, linkColor: OrbisPalette(scheme).accent.mathCSS, alignment: alignment)
        ZStack(alignment: .topLeading) {
            if !rendered { Text(source).reveal(clock, base: base, now: now).textSelection(.enabled) }
            MathWebSurface(content: content, clock: clock, base: base, now: now, length: String(source.characters).utf16.count, onSize: { id, value in
                guard id == revision, value.isFinite, (1...32768).contains(value) else { return }
                height = value; rendered = true
            }, onFailure: { rendered = false }, onLink: { target in
                guard let url = URL(string: target), !["javascript", "data", "vbscript", "orbis-math"].contains(url.scheme?.lowercased() ?? "") else { return }
                openURL(url)
            }).frame(height: rendered ? height : 1).opacity(rendered ? 1 : 0).accessibilityHidden(!rendered)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .task(id: settings) {
                let id = UUID().uuidString
                revision = id
                let next = await Task.detached(priority: .userInitiated) { settings.prepare(id: id) }.value
                guard !Task.isCancelled, revision == id else { return }
                content = next
            }
    }
}

private extension Color {
    var mathCSS: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(format: "#%02x%02x%02x", Int(red * 255), Int(green * 255), Int(blue * 255))
    }
}

private struct MathWebSettings: Equatable, Sendable {
    let html: String
    let size: CGFloat
    let bold: Bool
    let color: String
    let linkColor: String
    let alignment: String
    func prepare(id: String) -> MathWebContent? {
        let value: [String: Any] = ["revision": id, "html": html, "fontSize": size, "lineHeight": 1.5,
            "bold": bold, "color": color, "linkColor": linkColor, "align": alignment, "selectable": true]
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return MathWebContent(id: id, script: "OrbisMathView.update(" + json + ")")
    }
}
private struct MathWebContent: Sendable { let id: String; let script: String }

private struct MathWebSurface: UIViewRepresentable {
    let content: MathWebContent?
    let clock: RevealClock
    let base: Int
    let now: TimeInterval
    let length: Int
    let onSize: (String, CGFloat) -> Void
    let onFailure: () -> Void
    let onLink: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = MathWebStore.data
        configuration.setURLSchemeHandler(MathAssetHandler(), forURLScheme: "orbis-math")
        configuration.userContentController.add(context.coordinator, name: "math")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.navigationDelegate = context.coordinator
        context.coordinator.view = view
        view.load(URLRequest(url: URL(string: "orbis-math://bundle/index.html")!))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.send()
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.stopped = true; coordinator.view = nil
        view.stopLoading(); view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "math")
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MathWebSurface
        weak var view: WKWebView?
        var ready = false, stopped = false, failed = false
        var sent = ""
        var revealKey = ""
        init(_ parent: MathWebSurface) { self.parent = parent }
        func send() {
            guard ready, !stopped, !failed, let content = parent.content else { return }
            let key = "\(content.id):\(parent.base):\(parent.clock.known):\(parent.clock.settledBelow)"
            guard sent != content.id || revealKey != key else { return }
            var script = sent == content.id ? "" : content.script + ";"
            let from = max(0, parent.length - 128, parent.clock.settledBelow - parent.base)
            let known = max(0, min(parent.length, parent.clock.known - parent.base))
            let value: Any
            if parent.now == .greatestFiniteMagnitude || from >= parent.length { value = NSNull() }
            else {
                let delays: [Double] = (from..<max(from, known)).map { offset in
                    let global = offset + parent.base
                    guard let segment = parent.clock.segments.last(where: { $0.start <= global }) else { return -120 }
                    return (segment.startTime(global) - parent.now) * 1000
                }
                value = ["from": from, "known": known, "delays": delays]
            }
            guard let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
                  let json = String(data: data, encoding: .utf8) else { return }
            script += "OrbisMathView.reveal(" + json + ")"
            sent = content.id; revealKey = key
            view?.evaluateJavaScript(script) { [weak self] _, error in
                if error != nil { self?.fail() }
            }
        }
        func fail() {
            guard !stopped else { return }
            failed = true
            parent.onFailure()
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !stopped, !failed, message.frameInfo.isMainFrame,
                  message.frameInfo.request.url?.scheme == "orbis-math",
                  let value = message.body as? [String: Any] else { return }
            switch value["type"] as? String {
            case "ready": ready = true; send()
            case "size":
                if let id = value["revision"] as? String, let height = value["height"] as? Double { parent.onSize(id, height) }
            case "link":
                if let link = value["value"] as? String, link.count <= 4096 { parent.onLink(link) }
            case "failure": fail()
            default: break
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.request.url?.absoluteString == "orbis-math://bundle/index.html" && !ready ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail() }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
    }
}

private enum MathWebStore {
    // All fragments share one process/data store; no persistent cookies or web storage.
    static let data = WKWebsiteDataStore.nonPersistent()
}

private final class MathAssetHandler: NSObject, WKURLSchemeHandler {
    private let queue = DispatchQueue(label: "orbis.math.assets", qos: .userInitiated)
    private var active: Set<ObjectIdentifier> = []
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "bundle", let root = MathResources.root else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        let path = String(url.path.dropFirst())
        let allowed = ["index.html", "view.js", "view.css", "katex.min.js", "katex.min.css"]
        guard allowed.contains(path) || path.range(of: #"^fonts/[A-Za-z0-9_-]+\.woff2$"#, options: .regularExpression) != nil else {
            task.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        let id = ObjectIdentifier(task)
        active.insert(id)
        queue.async { [weak self] in
            let data = try? Data(contentsOf: root.appendingPathComponent(path))
            DispatchQueue.main.async {
                guard let self, self.active.remove(id) != nil else { return }
                guard let data else { task.didFailWithError(URLError(.fileDoesNotExist)); return }
                let mime = ["html": "text/html", "js": "application/javascript", "css": "text/css", "woff2": "font/woff2"][url.pathExtension] ?? "application/octet-stream"
                task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
                task.didReceive(data); task.didFinish()
            }
        }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { active.remove(ObjectIdentifier(task)) }
}
