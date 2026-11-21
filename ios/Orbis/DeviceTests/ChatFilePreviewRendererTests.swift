import AVKit
import CryptoKit
import SwiftUI
import WebKit
import XCTest
@testable import Orbis

/// SC119: execute the product's WebKit reader, not a test-owned approximation of its policy.
@MainActor final class ChatFilePreviewRendererTests: XCTestCase {
    func testStaticHTMLAndSVGRenderWithAnIsolatedDataStore() async throws {
        let policy = try await PreviewWebSurface.compilePolicy()
        let loaded = expectation(description: "in-memory preview loaded")
        let document = Data("""
            <!doctype html><html><head><title>Orbis preview fixture</title></head><body>
            <h1>Static report</h1><svg viewBox="0 0 160 80" width="160" height="80"><rect width="160" height="80" fill="#008000"/></svg>
            </body></html>
            """.utf8)
        let renderer = PreviewWebSurface(id: UUID(), document: document, policy: policy, fullScreen: true,
            admitted: { true }, loaded: { loaded.fulfill() }, failed: { XCTFail("Preview WebKit load failed") })
        let host = UIHostingController(rootView: renderer.frame(width: 320, height: 240))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKey() }
        await fulfillment(of: [loaded], timeout: 8)
        let web = try XCTUnwrap(browser(host.view))
        // Navigation completion may precede the title and the first layout reaching the UI process.
        try await until("document title and layout") { web.title == "Orbis preview fixture" && web.scrollView.contentSize.height > 0 }
        XCTAssertEqual(web.title, "Orbis preview fixture")
        XCTAssertEqual(web.url?.scheme, "orbis-file-preview")
        XCTAssertFalse(web.configuration.websiteDataStore.isPersistent)
        XCTAssertFalse(web.configuration.defaultWebpagePreferences.allowsContentJavaScript)
        XCTAssertTrue(web.scrollView.isScrollEnabled)
        XCTAssertTrue(web.scrollView.contentSize.height > 0)
        // A completed navigation can still have a white backing surface for the first frame.
        // Assert actual paint, using the fixture's distinct SVG fill instead of a timing sleep.
        var painted: UIImage?
        for _ in 0..<32 {
            let snapshot = try await web.takeSnapshot(configuration: nil)
            if containsSVGFill(snapshot) { painted = snapshot; break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let attachment = XCTAttachment(image: try XCTUnwrap(painted, "Static SVG did not paint"))
        attachment.name = "SC119-static-preview"; attachment.lifetime = .keepAlways
        add(attachment)
    }

    // SC119: a failure while the reader is open returns to its card, retaining the failure but not the document.
    func testFullScreenFailureReturnsToTheCard() async throws {
        let preview = ChatFilePreview(automaticTick: false)
        var sent: [[String: Any]] = []
        preview.send = { sent.append($0); return true }
        let artifact = UUID().uuidString
        let transfer = UUID().uuidString
        let key = ChatFilePreview.Key(session: "session", block: "report:0", source: .artifact(artifact), name: "report.html")
        let document = Data("<!doctype html><title>Preview report</title><p>Report</p>".utf8)
        preview.authenticated(host: "host", supportsPreview: true)
        preview.open(key)
        let selection = try XCTUnwrap(preview.current)
        let command = try XCTUnwrap(sent.last?["commandId"] as? String)
        XCTAssertTrue(preview.consume(["type": "file.preview.started", "protocolVersion": orbisProtocolVersion, "runtimeId": "host",
            "commandId": command, "transferId": transfer, "artifactId": artifact, "format": "html", "size": document.count,
            "sha256": SHA256.hash(data: document).map { String(format: "%02x", $0) }.joined()]))
        preview.tick()
        XCTAssertTrue(preview.consume(.init(runtimeId: "host", transferId: transfer, offset: 0, bytes: document)))
        try await until("verified preview") { preview.current?.phase == .ready }
        XCTAssertTrue(preview.setFullScreen(selection.id, true))
        let pages = OrbisPageStack([selection.id])
        let host = UIHostingController(rootView: OrbisPageHost(stack: pages, root: {
            ChatFilePreviewCard(preview: preview, key: key, canOpen: { true }) { Text("Download") }
        }, page: { id in
            ChatFilePreviewPage(preview: preview, id: id) {
                if pages.pages.last == id { pages.requestBack() }
            }
        })
        .orbisOverlayHost(OrbisOverlay())
        // This test mounts a standalone UIKit host, not a SwiftUI App scene.
        .environment(\.scenePhase, .active))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previousWindow?.makeKey(); preview.close() }
        try await until("full-screen preview") { self.browser(host.view)?.title == "Preview report" }
        preview.renderFailed(selection.id)
        try await until("chat card with no browser") { pages.pages.isEmpty && self.browser(host.view) == nil }
        XCTAssertEqual(preview.current?.key, key)
        XCTAssertEqual(preview.current?.phase, .failed(.unsupported))
        XCTAssertNil(preview.current?.document)
        XCTAssertEqual(sent.compactMap { $0["type"] as? String }, ["runtime.command", "artifact.read", "artifact.done"])
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
