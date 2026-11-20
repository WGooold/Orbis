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
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        await fulfillment(of: [loaded], timeout: 8)
        func browser(_ view: UIView) -> WKWebView? {
            if let view = view as? WKWebView { return view }
            return view.subviews.lazy.compactMap(browser).first
        }
        let web = try XCTUnwrap(browser(host.view))
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
