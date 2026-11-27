import AVKit
import CryptoKit
import SwiftUI
import WebKit
import XCTest
@testable import Orbis

/// SC119 / SC128: execute the product's WebKit reader, not a test-owned approximation of its policy.
@MainActor final class ChatFilePreviewRendererTests: XCTestCase {
    /// Answers the preview's web commands the way a Host does: reply, then the range sent with it.
    @MainActor private final class FakeHost {
        let preview = ChatFilePreview(automaticTick: false)
        let artifact = UUID().uuidString
        var files: [String: (body: Data, mime: String)] = [:]
        var requested: [String] = []
        var sent: [[String: Any]] = []
        init() {
            preview.send = { [unowned self] message in
                sent.append(message)
                guard message["type"] as? String == "runtime.command", let id = message["commandId"] as? String,
                      let web = (message["command"] as? [String: Any])?["web"] as? [String: Any],
                      let transfer = web["transferId"] as? String else { return true }
                let path = web["resource"] as? String ?? "report.html"
                if web["resource"] != nil { requested.append(path) }
                DispatchQueue.main.async { self.answer(id, transfer: transfer, path: path) }
                return true
            }
            preview.authenticated(host: "host", supportsWeb: true)
        }
        var key: ChatFilePreview.Key { .init(session: "session", block: "report:0", source: .artifact(artifact), name: "report.html") }
        private func answer(_ command: String, transfer: String, path: String) {
            guard let file = files[path] else {
                preview.consume(["type": "file.preview.failed", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                                 "commandId": command, "reason": "unavailable"]); return
            }
            preview.consume(["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                "commandId": command, "transferId": transfer, "artifactId": artifact, "format": "web", "size": file.body.count,
                "contentSize": file.body.count, "encoding": "identity", "mimeType": file.mime, "resource": path,
                "sha256": SHA256.hash(data: file.body).map { String(format: "%02x", $0) }.joined()])
            _ = preview.consume(ArtifactChunk(runtimeId: "host", transferId: transfer, offset: 0, bytes: file.body))
        }
    }

    /// A page as agents write it: an external stylesheet and script, inline script, and attempts to reach the network.
    private func agentPage() -> FakeHost {
        let host = FakeHost()
        host.files["report.html"] = (Data("""
            <!doctype html><html><head><meta name="viewport" content="width=device-width"><title>loading</title>
            <link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://example.com/remote.css"></head>
            <body><div id="box"></div><img id="local" src="pixel.png"><img src="https://example.com/beacon.png"><script src="app.js"></script></body></html>
            """.utf8), "text/html; charset=utf-8")
        host.files["style.css"] = (Data(":root{--fill:#008000}#box{background:var(--fill);width:160px;height:80px;display:grid}".utf8), "text/css; charset=utf-8")
        let pixel = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor(red: 0, green: 0.5, blue: 0, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        host.files["pixel.png"] = (pixel.pngData()!, "image/png")
        host.files["app.js"] = (Data("""
            document.title = "ran";
            fetch("https://example.com/collect").then(() => { document.title += "|network"; }, () => { document.title += "|blocked"; });
            document.title += typeof RTCPeerConnection === "undefined" ? "|no-rtc" : "|rtc";
            document.getElementById("local").decode().then(() => { document.title += "|img"; }, () => { document.title += "|no-img"; });
            """.utf8), "text/javascript; charset=utf-8")
        return host
    }

    private func readyPage(_ host: FakeHost) async throws -> ChatFilePreview.Selection {
        host.preview.open(host.key)
        try await until("verified entry") { host.preview.current?.phase == .ready }
        return try XCTUnwrap(host.preview.current)
    }

    func testOriginalPageRunsScriptsAndLoadsOnlyItsOwnFilesOffline() async throws {
        let host = agentPage()
        let selection = try await readyPage(host)
        let policy = try await PreviewWebSurface.compilePolicy()
        let renderer = PreviewWebSurface(page: selection.id, entry: try XCTUnwrap(selection.entry),
            resources: { path, done in host.preview.resource(selection.id, path: path) { done(try? $0.get()) } }, policy: policy,
            interactive: true, admitted: { true }, painted: {}, captured: { _ in }, failed: { XCTFail("Preview WebKit load failed") })
        let controller = UIHostingController(rootView: renderer.frame(width: 320, height: 240))
        try await withWindow(controller) {
            try await until("page scripts, its image and blocked network") {
                self.browser(controller.view)?.title.map { $0.contains("blocked") && $0.contains("img") } == true
            }
            let web = try XCTUnwrap(browser(controller.view))
            XCTAssertEqual(Set((web.title ?? "").split(separator: "|").map(String.init)), ["ran", "no-rtc", "blocked", "img"])
            XCTAssertEqual(web.url?.scheme, PreviewWebSurface.scheme)
            XCTAssertFalse(web.configuration.websiteDataStore.isPersistent)
            XCTAssertTrue(web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
            XCTAssertEqual(Set(host.requested), ["style.css", "app.js", "pixel.png"])
            var painted: UIImage?
            for _ in 0..<32 {
                let snapshot = try await web.takeSnapshot(configuration: nil)
                if containsSVGFill(snapshot) { painted = snapshot; break }
                try await Task.sleep(for: .milliseconds(100))
            }
            let attachment = XCTAttachment(image: try XCTUnwrap(painted, "Stylesheet from a sibling file did not paint"))
            attachment.name = "SC128-original-page"; attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    // SC128: the card keeps a still image of the rendered page, not a live WebView.
    func testInlineReaderCapturesAStillImage() async throws {
        let host = agentPage()
        let selection = try await readyPage(host)
        let policy = try await PreviewWebSurface.compilePolicy()
        var still: CGImage?
        let renderer = PreviewWebSurface(page: selection.id, entry: try XCTUnwrap(selection.entry),
            resources: { path, done in host.preview.resource(selection.id, path: path) { done(try? $0.get()) } }, policy: policy,
            interactive: false, admitted: { true }, painted: {}, captured: { image in still = image; host.preview.setSnapshot(selection.id, image) },
            failed: { XCTFail("Preview WebKit load failed") })
        let controller = UIHostingController(rootView: renderer.frame(width: 320, height: 240))
        try await withWindow(controller) {
            try await until("card image") { still != nil }
            XCTAssertFalse(try XCTUnwrap(browser(controller.view)).isUserInteractionEnabled)
        }
        let image = try XCTUnwrap(still)
        XCTAssertTrue(containsSVGFill(UIImage(cgImage: image)))
        XCTAssertTrue(host.preview.current?.snapshot === image)
        let attachment = XCTAttachment(image: UIImage(cgImage: image))
        attachment.name = "SC128-card-image"; attachment.lifetime = .keepAlways
        add(attachment)
    }

    // SC128: the card's states as the user sees them (collapsed, loading with bytes, page image, failure), for review.
    func testCardStatesForReview() async throws {
        let idle = ChatFilePreview(automaticTick: false)
        idle.authenticated(host: "host", supportsWeb: true)
        let idleKey = ChatFilePreview.Key(session: "session", block: "idle", source: .artifact(UUID().uuidString), name: "weekly-report.html")
        let host = agentPage()
        let ready = try await readyPage(host)
        let still = UIGraphicsImageRenderer(size: CGSize(width: 360, height: 240)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 360, height: 240))
            UIColor(red: 0.42, green: 0.36, blue: 1, alpha: 1).setFill(); context.fill(CGRect(x: 16, y: 16, width: 328, height: 56))
            UIColor(white: 0.9, alpha: 1).setFill()
            for row in 0..<5 { context.fill(CGRect(x: 16, y: 88 + row * 28, width: row % 2 == 0 ? 300 : 220, height: 14)) }
        }
        host.preview.setSnapshot(ready.id, try XCTUnwrap(still.cgImage))
        let progress = FakeHost()
        progress.files["report.html"] = (Data(repeating: 65, count: 900 * 1024), "text/html; charset=utf-8")
        progress.preview.send = { message in
            // Accept, push the first range, answer ranges below 512 KiB and leave the rest outstanding.
            let body = progress.files["report.html"]!.body
            if message["type"] as? String == "artifact.read", let transfer = message["transferId"] as? String,
               let offset = message["offset"] as? Int, let length = message["length"] as? Int, offset < 512 * 1024 {
                DispatchQueue.main.async {
                    _ = progress.preview.consume(ArtifactChunk(runtimeId: "host", transferId: transfer, offset: Int64(offset), bytes: body.subdata(in: offset..<offset + length)))
                }
                return true
            }
            guard let id = message["commandId"] as? String, let web = (message["command"] as? [String: Any])?["web"] as? [String: Any],
                  let transfer = web["transferId"] as? String else { return true }
            DispatchQueue.main.async {
                progress.preview.consume(["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                    "commandId": id, "transferId": transfer, "artifactId": progress.artifact, "format": "web", "size": body.count,
                    "contentSize": body.count, "encoding": "identity", "mimeType": "text/html; charset=utf-8", "resource": "report.html",
                    "sha256": SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()])
                _ = progress.preview.consume(ArtifactChunk(runtimeId: "host", transferId: transfer, offset: 0, bytes: body.prefix(ChatFilePreview.rangeBytes)))
            }
            return true
        }
        progress.preview.open(progress.key)
        try await until("loading progress") { (progress.preview.current?.progress?.received ?? 0) >= 512 * 1024 }
        let tooLarge = ChatFilePreview(automaticTick: false)
        var sent: [[String: Any]] = []
        tooLarge.send = { sent.append($0); return true }
        tooLarge.authenticated(host: "host", supportsWeb: true)
        let largeKey = ChatFilePreview.Key(session: "session", block: "large", source: .artifact(UUID().uuidString), name: "annual-deck.html")
        tooLarge.open(largeKey)
        tooLarge.consume(["type": "file.preview.failed", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
                          "commandId": try XCTUnwrap(sent.last?["commandId"] as? String), "reason": "too_large"])
        let view = ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ChatFilePreviewCard(preview: idle, key: idleKey, label: "weekly-report.html", downloadIdentifier: "d0", canOpen: { true }, download: {})
                ChatFilePreviewCard(preview: progress.preview, key: progress.key, label: "dashboard.html", downloadIdentifier: "d1", canOpen: { true }, download: {})
                ChatFilePreviewCard(preview: host.preview, key: host.key, label: "report.html", downloadIdentifier: "d2", canOpen: { true }, download: {})
                ChatFilePreviewCard(preview: tooLarge, key: largeKey, label: "annual-deck.html", downloadIdentifier: "d3", canOpen: { true }, download: {})
            }.padding(16)
        }
        .environment(\.openChatFilePreview, { _ in })
        .environment(\.scenePhase, .active)
        .background(OrbisPalette(.light).base)
        let controller = UIHostingController(rootView: view)
        try await withWindow(controller) {
            try await Task.sleep(for: .milliseconds(600))
            let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "SC128-card-states"; attachment.lifetime = .keepAlways
            add(attachment)
        }
        progress.preview.close(); host.preview.close(); tooLarge.close()
    }

    // SC119: a failure while the reader is open returns to its card, retaining the failure but not the document.
    func testFullScreenFailureReturnsToTheCard() async throws {
        let host = agentPage()
        let selection = try await readyPage(host)
        let preview = host.preview, key = host.key
        XCTAssertTrue(preview.setFullScreen(selection.id, true))
        let pages = OrbisPageStack([selection.id])
        let controller = UIHostingController(rootView: OrbisPageHost(stack: pages, root: {
            ChatFilePreviewCard(preview: preview, key: key, label: "report.html", downloadIdentifier: "download", canOpen: { true }, download: {})
        }, page: { id in
            ChatFilePreviewPage(preview: preview, id: id) {
                if pages.pages.last == id { pages.requestBack() }
            }
        })
        .orbisOverlayHost(OrbisOverlay())
        // This test mounts a standalone UIKit host, not a SwiftUI App scene.
        .environment(\.scenePhase, .active))
        try await withWindow(controller) {
            try await until("full-screen preview") { self.browser(controller.view)?.title?.hasPrefix("ran") == true }
            preview.renderFailed(selection.id)
            try await until("chat card with no browser") { pages.pages.isEmpty && self.browser(controller.view) == nil }
        }
        XCTAssertEqual(preview.current?.key, key)
        XCTAssertEqual(preview.current?.phase, .failed(.unsupported))
        XCTAssertNil(preview.current?.entry)
        preview.close()
        XCTAssertFalse(host.sent.contains { $0["type"] as? String == "artifact.read" }, "single-range files need no further reads")
    }

    // SC122: exercise the native image/PDF/text decoder and the actual system video player.
    func testNativeReadersUseTheVerifiedLocalBytes() async throws {
        let raster = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).image { context in
            UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        for (format, data) in [(ChatFilePreview.Format.png, raster.pngData()), (.jpeg, raster.jpegData(compressionQuality: 0.9))] {
            guard case .image(let image) = try await FileReaderWorker.shared.read(.snapshot(try XCTUnwrap(data)), format: format, fullScreen: false) else {
                return XCTFail("Expected an image")
            }
            XCTAssertGreaterThan(image.width, 0)
            XCTAssertLessThanOrEqual(image.width, 640)
        }
        let box = CGRect(x: 0, y: 0, width: 90, height: 60)
        let pdf = UIGraphicsPDFRenderer(bounds: box).pdfData { context in
            for color in [UIColor.green, UIColor.blue] {
                context.beginPage(); color.setFill(); context.cgContext.fill(box)
            }
        }
        guard case .pdf(_, let pageCount, let first) = try await FileReaderWorker.shared.read(.snapshot(pdf), format: .pdf, fullScreen: false) else {
            return XCTFail("Expected a PDF")
        }
        XCTAssertEqual(pageCount, 2); XCTAssertEqual(first.width, 640)
        let second = try await FileReaderWorker.shared.pdfPage(pdf, page: 2)
        XCTAssertEqual(second.width, 2048)
        let text = "{\"mode\":\"<script>read as text</script>\"}"
        guard case .text(let rendered, let truncated) = try await FileReaderWorker.shared.read(.snapshot(Data(text.utf8)), format: .text, fullScreen: true) else {
            return XCTFail("Expected text")
        }
        XCTAssertEqual(rendered, text); XCTAssertFalse(truncated)
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "preview", withExtension: "mp4"))
        let bytes = try Data(contentsOf: fixture)
        let host = UIHostingController(rootView: NativeFileReader(source: .snapshot(bytes), format: .mp4, fullScreen: true) {
            XCTFail("Local MP4 preview failed")
        })
        try await withWindow(host) {
            try await until("prepared local video") { self.player(host)?.player?.currentItem?.status == .readyToPlay }
            let player = try XCTUnwrap(self.player(host)?.player)
            XCTAssertEqual(player.rate, 0)
            XCTAssertEqual(player.timeControlStatus, .paused)
            XCTAssertTrue((player.currentItem?.asset as? AVURLAsset)?.url.isFileURL == true)
            XCTAssertNil(self.browser(host.view))
        }
    }

    // SC133: Markdown files use the existing native Markdown parser and never become executable web content.
    func testMarkdownFileReaderUsesTheNativeMarkdownRenderer() async throws {
        let source = "# Release notes\n\n**Stable**\n\n- Ready"
        let format = try XCTUnwrap(ChatFilePreview.Format(fileName: "release-notes.md"))
        XCTAssertEqual(format, .markdown)
        XCTAssertEqual(format.wireValue, "text")
        guard case .text(let decoded, false) = try await FileReaderWorker.shared.read(
            .snapshot(Data(source.utf8)), format: format, fullScreen: true
        ) else { return XCTFail("Expected the bounded Markdown text") }
        XCTAssertEqual(decoded, source)

        let host = UIHostingController(rootView: NativeFileReader(source: .snapshot(Data(source.utf8)), format: format,
            fullScreen: true) { XCTFail("Valid Markdown failed to render") })
        try await withWindow(host) {
            try await until("prepared Markdown document") { MarkdownDocuments.cached(source) != nil }
            let rows = try XCTUnwrap(MarkdownDocuments.cached(source)?.rows)
            XCTAssertTrue(rows.contains { row in
                if case .heading(_, let value) = row.kind { return String(value.characters) == "Release notes" }
                return false
            }, "The leading # syntax must be parsed into a heading row")
            XCTAssertTrue(rows.contains { row in
                if case .text(let value) = row.kind { return String(value.characters) == "Stable" }
                return false
            }, "The emphasized paragraph must be parsed into inline Markdown")
            XCTAssertTrue(rows.contains { row in
                if case .bullet(_, let value) = row.kind { return String(value.characters) == "Ready" }
                return false
            }, "The list marker must be parsed into a list row")
            XCTAssertNil(browser(host.view), "Markdown remains in the native renderer rather than a web view")
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "SC133-native-markdown-reader"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    // SC123: a read-only page uses the locally saved copy (and refuses a changed copy).
    func testCompletedDownloadReaderIsLocalAndRechecksTheDigest() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        let bytes = Data("Saved on phone".utf8)
        try bytes.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard case .text(let displayed, false) = try await FileReaderWorker.shared.read(.download(file, sha256: hash), format: .text, fullScreen: true) else {
            return XCTFail("Expected the saved local text")
        }
        XCTAssertEqual(displayed, "Saved on phone")
        let office = try await FileReaderWorker.shared.office(file, name: "report.docx", sha256: hash)
        XCTAssertEqual(office.url.pathExtension, "docx")
        XCTAssertNotEqual(office.url, file)
        XCTAssertEqual(try Data(contentsOf: office.url), bytes)
        try Data("changed".utf8).write(to: file)
        do {
            _ = try await FileReaderWorker.shared.read(.download(file, sha256: hash), format: .text, fullScreen: true)
            XCTFail("An edited download must not be treated as the verified file")
        } catch { XCTAssertEqual((error as NSError).code, CocoaError.fileReadCorruptFile.rawValue) }
    }

    // SC130: a saved page opens offline in the preview reader; a copy that no longer matches its digest does not.
    func testSavedPageOpensInTheOfflineReaderOnlyWhenItMatches() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".html")
        let bytes = Data("<!doctype html><title>Saved page</title><link rel=\"stylesheet\" href=\"theme.css\"><script>document.title += '|js'</script>".utf8)
        try bytes.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        func task(_ sha256: String) -> FileTransfer {
            FileTransfer(id: UUID().uuidString, hostKey: "host", hostId: "host", runtimeId: "host", sessionId: nil, direction: "download",
                         name: "saved.html", size: Int64(bytes.count), received: Int64(bytes.count), sha256: sha256,
                         localPath: file.path, status: "completed")
        }
        let saved = UIHostingController(rootView: DownloadedFilePage(task: task(hash), back: {}).environment(\.scenePhase, .active))
        try await withWindow(saved) {
            try await until("saved page with its script") { self.browser(saved.view)?.title == "Saved page|js" }
            XCTAssertFalse(try XCTUnwrap(browser(saved.view)).configuration.websiteDataStore.isPersistent)
        }
        let changed = UIHostingController(rootView: DownloadedFilePage(task: task(String(repeating: "0", count: 64)), back: {})
            .environment(\.scenePhase, .active))
        try await withWindow(changed) {
            try await Task.sleep(for: .milliseconds(800))
            XCTAssertNil(browser(changed.view))
        }
    }

    private func player(_ controller: UIViewController) -> AVPlayerViewController? {
        (controller as? AVPlayerViewController) ?? controller.children.lazy.compactMap(player).first
    }

    private func withWindow(_ host: UIViewController, run: () async throws -> Void) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.keyWindow
        let window = UIWindow(windowScene: scene); window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        try await run()
    }

    private func until(_ description: String, _ condition: () -> Bool) async throws {
        for _ in 0..<150 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Timed out: \(description)")
        throw URLError(.timedOut)
    }

    private func browser(_ view: UIView) -> WKWebView? {
        if let view = view as? WKWebView { return view }
        return view.subviews.lazy.compactMap(browser).first
    }

    private func containsSVGFill(_ image: UIImage) -> Bool {
        guard let source = image.cgImage else { return false }
        let width = 80, height = 60
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let painted = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard painted else { return false }
        return stride(from: 0, to: bytes.count, by: 4).filter { p in
            bytes[p] < 20 && (110...145).contains(bytes[p + 1]) && bytes[p + 2] < 20
        }.count >= 16
    }
}
