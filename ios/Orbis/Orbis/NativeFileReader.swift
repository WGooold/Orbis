import AVKit
import CryptoKit
import ImageIO
import QuickLook
import SwiftUI
import WebKit

/// FILE-PREVIEW-02. Live chat supplies the verified snapshot; Downloads supplies an owned local file.
enum NativeFileReaderSource: Equatable, Sendable {
    case snapshot(Data)
    case download(URL, sha256: String?)
}

enum FileReaderContent: Sendable {
    case image(CGImage)
    case pdf(Data, pageCount: Int, first: CGImage)
    case text(String, truncated: Bool)
    case video(ReaderTemporaryFile)
}

final class ReaderTemporaryFile: Sendable {
    let url: URL
    init(suffix: String) { url = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-preview-\(UUID()).\(suffix)") }
    deinit { let file = url; Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: file) } }

}

private func localVideoAsset(_ file: ReaderTemporaryFile) -> AVURLAsset {
    AVURLAsset(url: file.url, options: [AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue])
}

private let officeExtensions: Set<String> = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"]

/// One decoder at a time, including during fast replacement of a preview. No file work in body/updateUIView.
actor FileReaderWorker {
    static let shared = FileReaderWorker()
    private let unsupported = CocoaError(.fileReadCorruptFile)
    private var sweptTemporaryFiles = false

    /// FILE-PREVIEW-03: a saved page opens in the offline reader from a digest-checked copy of the local file.
    func webPage(_ url: URL, name: String, sha256: String?) throws -> ChatFilePreview.WebResource {
        guard let format = ChatFilePreview.Format(fileName: name), format.isWeb else { throw unsupported }
        let bytes = try snapshot(url, limit: format.budget, sha256: sha256)
        guard !bytes.isEmpty else { throw unsupported }
        let text = format == .svg ? "image/svg+xml" : "text/html"
        let mime = String(data: bytes, encoding: .utf8) != nil ? text + "; charset=utf-8" : text
        return .init(path: "page." + (format == .svg ? "svg" : "html"), mimeType: mime, body: bytes,
                     sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }

    func read(_ source: NativeFileReaderSource, format: ChatFilePreview.Format, fullScreen: Bool) async throws -> FileReaderContent {
        try Task.checkCancellation()
        let bytes: Data
        switch source {
        case .snapshot(let data): bytes = data
        case .download(let url, let sha256): bytes = try snapshot(url, limit: format.budget, sha256: sha256)
        }
        try Task.checkCancellation()
        guard !bytes.isEmpty, bytes.count <= format.budget, !format.isWeb, format.matchesBytes(bytes) else { throw unsupported }
        let edge = fullScreen ? 2_048 : 640
        switch format {
        case .jpeg, .png:
            guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  CGImageSourceGetCount(source) == 1,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  (1...8192).contains(width), (1...8192).contains(height), width * height <= 16_000_000,
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: edge] as CFDictionary) else { throw unsupported }
            return .image(image)
        case .pdf:
            let doc = try pdfDocument(bytes)
            return .pdf(bytes, pageCount: doc.numberOfPages, first: try drawPDF(doc, page: 1, edge: edge))
        case .text:
            guard let text = String(data: bytes, encoding: .utf8) else { throw unsupported }
            let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            let prefix = String(normalized.unicodeScalars.prefix(fullScreen ? 16_384 : 4_096))
            let rendered = prefix.split(separator: "\n", maxSplits: 250, omittingEmptySubsequences: false).prefix(250).joined(separator: "\n")
            return .text(rendered, truncated: rendered.utf8.count < normalized.utf8.count)
        case .mp4:
            guard fullScreen else { throw unsupported }
            let file = try stage(bytes, suffix: "mp4")
            let asset = localVideoAsset(file)
            let (playable, duration) = try await asset.load(.isPlayable, .duration)
            let tracks = try await asset.loadTracks(withMediaType: .video)
            guard playable, duration.seconds.isFinite, duration.seconds > 0, duration.seconds <= 180,
                  !tracks.isEmpty, tracks.count <= 16 else { throw unsupported }
            for track in tracks {
                let size = try await track.load(.naturalSize)
                guard (1...1920).contains(size.width), (1...1920).contains(size.height), size.width * size.height <= 1920 * 1080 else { throw unsupported }
            }
            try Task.checkCancellation()
            return .video(file)
        case .html, .svg: throw unsupported
        }
    }

    func office(_ url: URL, name: String, sha256: String?) throws -> ReaderTemporaryFile {
        try Task.checkCancellation()
        let suffix = (name as NSString).pathExtension.lowercased()
        guard officeExtensions.contains(suffix) else { throw unsupported }
        let bytes = try snapshot(url, limit: 32 * 1024 * 1024, sha256: sha256)
        try Task.checkCancellation()
        return try stage(bytes, suffix: suffix)
    }

    private func snapshot(_ url: URL, limit: Int, sha256: String?) throws -> Data {
        try Self.checkFile(url, maxBytes: limit)
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        // Snapshot, rather than mmap or hand a writable Downloads path to a reader.
        let bytes = try handle.read(upToCount: limit + 1) ?? Data()
        guard bytes.count > 0, bytes.count <= limit else { throw unsupported }
        if let sha256 {
            guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw unsupported }
        }
        return bytes
    }

    private func stage(_ bytes: Data, suffix: String) throws -> ReaderTemporaryFile {
        if !sweptTemporaryFiles {
            sweptTemporaryFiles = true
            let fm = FileManager.default
            let entries = (try? fm.contentsOfDirectory(at: fm.temporaryDirectory, includingPropertiesForKeys: nil)) ?? []
            for stale in entries where stale.lastPathComponent.hasPrefix("orbis-preview-") &&
                (officeExtensions.contains(stale.pathExtension) || stale.pathExtension == "mp4") {
                try? fm.removeItem(at: stale)
            }
        }
        let file = ReaderTemporaryFile(suffix: suffix)
        try bytes.write(to: file.url, options: .atomic)
        return file
    }

    func pdfPage(_ data: Data, page: Int) throws -> CGImage {
        try Task.checkCancellation()
        return try drawPDF(pdfDocument(data), page: page, edge: 2048)
    }

    private func pdfDocument(_ data: Data) throws -> CGPDFDocument {
        guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider),
              !doc.isEncrypted, (1...100).contains(doc.numberOfPages) else { throw unsupported }
        return doc
    }

    private func drawPDF(_ doc: CGPDFDocument, page: Int, edge: Int) throws -> CGImage {
        guard let page = doc.page(at: page) else { throw unsupported }
        let box = page.getBoxRect(.cropBox)
        let rotated = page.rotationAngle % 180 != 0
        let width = rotated ? box.height : box.width, height = rotated ? box.width : box.height
        guard [box.minX, box.minY, width, height].allSatisfy(\.isFinite), width > 0, height > 0 else { throw unsupported }
        let scale = CGFloat(edge) / max(width, height)
        let w = max(1, Int((width * scale).rounded())), h = max(1, Int((height * scale).rounded()))
        guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw unsupported }
        let canvas = CGRect(x: 0, y: 0, width: w, height: h)
        context.setFillColor(gray: 1, alpha: 1); context.fill(canvas)
        context.concatenate(page.getDrawingTransform(.cropBox, rect: canvas, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(page)
        guard let result = context.makeImage() else { throw unsupported }
        return result
    }

    static func checkFile(_ url: URL, maxBytes: Int? = nil) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize,
              size >= 0, maxBytes.map({ size <= $0 }) ?? true else { throw CocoaError(.fileReadNoSuchFile) }
    }
}

struct NativeFileReader: View {
    let source: NativeFileReaderSource
    let format: ChatFilePreview.Format
    let fullScreen: Bool
    var onFailure: () -> Void = {}
    @State private var content: FileReaderContent?
    @State private var failed = false

    var body: some View {
        Group {
            switch content {
            case .image(let image):
                if fullScreen { PreviewZoomImage(image: image) }
                else { thumbnail(image) }
            case .pdf(let bytes, let pageCount, let first):
                if fullScreen { PDFPreviewPages(bytes: bytes, pageCount: pageCount, first: first) }
                else { thumbnail(first) }
            case .text(let text, let truncated):
                if fullScreen { ScrollView { textView(text, truncated: truncated).textSelection(.enabled) } }
                else { textView(text, truncated: false).clipped() }
            case .video(let file): LocalVideoPreview(file: file, failed: fail)
            case nil:
                if failed { Text(L10n.tr("此文件无法预览")).font(.orbisLabel()) }
                else { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .task {
                do {
                    let value = try await FileReaderWorker.shared.read(source, format: format, fullScreen: fullScreen)
                    if !Task.isCancelled { content = value }
                } catch { if !Task.isCancelled { fail() } }
            }
    }

    private func fail() { content = nil; failed = true; onFailure() }

    private func thumbnail(_ image: CGImage) -> some View {
        Image(decorative: image, scale: 1).resizable().scaledToFit().padding(8)
    }

    private func textView(_ text: String, truncated: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: text).font(.system(.footnote, design: .monospaced)).lineLimit(fullScreen ? nil : 14)
            if truncated { Text(L10n.tr("内容已截断")).font(.orbisCaption()) }
        }.padding(12).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct PDFPreviewPages: View {
    let bytes: Data
    let pageCount: Int
    let first: CGImage
    @State private var page = 1
    @State private var raster: (page: Int, image: CGImage)?
    @State private var failedPage: Int?
    var body: some View {
        VStack(spacing: 8) {
            Group {
                if page == 1 { PreviewZoomImage(image: first).id(page) }
                else if let raster, raster.page == page { PreviewZoomImage(image: raster.image).id(page) }
                else if failedPage == page { Text(L10n.tr("此文件无法预览")).font(.orbisLabel()) }
                else { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                OrbisIconButton(symbol: "chevron.left", label: L10n.tr("上一页")) { page -= 1 }.disabled(page <= 1)
                Text("\(page) / \(pageCount)").font(.orbisCaption()).monospacedDigit()
                OrbisIconButton(symbol: "chevron.right", label: L10n.tr("下一页")) { page += 1 }.disabled(page >= pageCount)
            }.padding(.bottom, 8)
        }.task(id: page) {
            let target = page
            raster = nil; failedPage = nil
            guard target > 1 else { return }
            do {
                let image = try await FileReaderWorker.shared.pdfPage(bytes, page: target)
                if !Task.isCancelled, page == target { raster = (target, image) }
            } catch { if !Task.isCancelled, page == target { failedPage = target } }
        }
    }
}

private struct PreviewZoomImage: UIViewRepresentable {
    let image: CGImage
    func makeUIView(context: Context) -> PreviewZoomScroll {
        PreviewZoomScroll(frame: .zero)
    }
    func updateUIView(_ view: PreviewZoomScroll, context: Context) { view.setImage(image) }
}

private final class PreviewZoomScroll: UIScrollView, UIScrollViewDelegate {
    private let artwork = UIImageView()
    private var current: CGImage?
    private var fitted: CGSize = .zero
    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self; maximumZoomScale = 4; bouncesZoom = true
        contentInsetAdjustmentBehavior = .never
        artwork.contentMode = .scaleAspectFit
        addSubview(artwork)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setImage(_ image: CGImage) {
        guard current !== image else { return }
        current = image; artwork.image = UIImage(cgImage: image); fitted = .zero
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != fitted, bounds.width > 0, bounds.height > 0, let image = artwork.image {
            fitted = bounds.size; zoomScale = 1
            let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
            artwork.frame = CGRect(origin: .zero, size: CGSize(width: image.size.width * scale, height: image.size.height * scale))
            contentSize = artwork.bounds.size
        }
        centerArtwork()
    }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { artwork }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerArtwork() }
    private func centerArtwork() {
        artwork.center = CGPoint(x: max(bounds.width, contentSize.width) / 2, y: max(bounds.height, contentSize.height) / 2)
    }
}

private struct LocalVideoPreview: UIViewControllerRepresentable {
    let file: ReaderTemporaryFile
    let failed: () -> Void
    final class Coordinator { var status: NSKeyValueObservation? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let item = AVPlayerItem(asset: localVideoAsset(file))
        let controller = AVPlayerViewController()
        controller.allowsPictureInPicturePlayback = false
        let player = AVPlayer(playerItem: item)
        player.allowsExternalPlayback = false
        controller.player = player
        context.coordinator.status = item.observe(\.status, options: [.initial, .new]) { item, _ in
            if item.status == .failed { Task { @MainActor in failed() } }
        }
        return controller // Neither opening nor preparing the player calls play().
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.status = nil; controller.player?.pause(); controller.player = nil
    }
}

struct DownloadedFilePage: View {
    let task: FileTransfer?
    let back: () -> Void
    @Environment(\.orbisPageActivity) private var activity
    @Environment(\.scenePhase) private var phase
    @State private var file: URL?
    @State private var unreadable = false
    @State private var officeCopy: ReaderTemporaryFile?
    @State private var preparingOffice = false

    var body: some View {
        VStack(spacing: 0) {
            OrbisPageHeader(title: task?.name ?? L10n.tr("预览"), back: back) {
                if let file, task != nil {
                    ShareLink(item: file) { OrbisActionSymbol(systemName: "square.and.arrow.up").frame(width: 48, height: 48) }
                        .accessibilityLabel(L10n.tr("分享"))
                }
            }
            Group {
                if let file, let task, activity.isTop, phase == .active {
                    if let format = ChatFilePreview.Format(fileName: task.name), !format.isWeb {
                        NativeFileReader(source: .download(file, sha256: task.sha256), format: format, fullScreen: true)
                    } else if ChatFilePreview.Format(fileName: task.name)?.isWeb == true {
                        DownloadedWebPage(file: file, task: task)
                    } else if let officeCopy, QLPreviewController.canPreview(officeCopy.url as NSURL) {
                        OfficeQuickLook(file: officeCopy)
                    } else if preparingOffice {
                        ProgressView().accessibilityLabel(L10n.tr("正在加载预览"))
                    } else {
                        Text(L10n.tr("此文件无法预览")).font(.orbisLabel())
                    }
                } else if unreadable || task == nil { Text(L10n.tr("此文件无法预览")).font(.orbisLabel()) }
                else if file == nil { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.task(id: task?.id) {
            file = nil; officeCopy = nil; unreadable = false; preparingOffice = false
            guard let task, let path = task.localPath else { return }
            let url = URL(fileURLWithPath: path)
            let valid = await Task.detached(priority: .utility) { (try? FileReaderWorker.checkFile(url)) != nil }.value
            guard !Task.isCancelled else { return }
            guard valid else { unreadable = true; return }
            preparingOffice = officeExtensions.contains((task.name as NSString).pathExtension.lowercased())
            file = url
            if preparingOffice {
                let copy = try? await FileReaderWorker.shared.office(url, name: task.name, sha256: task.sha256)
                if !Task.isCancelled { officeCopy = copy; preparingOffice = false }
            }
        }
    }
}

/// A saved page in the same offline reader as chat previews. Only the file itself is served; it has no Host,
/// so files it references are missing rather than fetched.
private struct DownloadedWebPage: View {
    let file: URL
    let task: FileTransfer
    @State private var page: ChatFilePreview.WebResource?
    @State private var policy: WKContentRuleList?
    @State private var painted = false
    @State private var failed = false
    @State private var id = UUID()
    var body: some View {
        ZStack {
            if failed { Text(L10n.tr("此文件无法预览")).font(.orbisLabel()) }
            else if let page, let policy {
                PreviewWebSurface(page: id, entry: page, resources: { path, done in
                    done(path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == page.path ? page : nil)
                }, policy: policy, interactive: true, admitted: { true }, painted: { painted = true }, captured: { _ in },
                    failed: { failed = true })
                .opacity(painted ? 1 : 0)
                .accessibilityIdentifier("downloaded-web-page")
            }
            if !painted && !failed { ProgressView().accessibilityLabel(L10n.tr("正在加载预览")) }
        }
        .task(id: task.id) {
            do {
                let verified = try await FileReaderWorker.shared.webPage(file, name: task.name, sha256: task.sha256)
                let compiled = try await PreviewWebSurface.compilePolicy()
                if !Task.isCancelled { page = verified; policy = compiled }
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

private struct OfficeQuickLook: UIViewControllerRepresentable {
    let file: ReaderTemporaryFile
    final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        // Keep the verified copy alive until Quick Look releases its controller.
        let file: ReaderTemporaryFile
        init(_ file: ReaderTemporaryFile) { self.file = file }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { file.url as NSURL }
        func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode { .disabled }
    }
    func makeCoordinator() -> Coordinator { Coordinator(file) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
}
