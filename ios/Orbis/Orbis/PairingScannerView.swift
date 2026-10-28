import SwiftUI
import AVFoundation

struct PairingEntryView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @State private var code = ""
    @State private var scannerOpen = false
    @State private var manualOpen = false
    @State private var validationError: String?
    @FocusState private var codeFocused: Bool
    let onCancel: (() -> Void)?
    let onCode: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            OrbisHeader {
                if let onCancel { OrbisIconButton(symbol: "xmark", label: "取消添加电脑", action: onCancel) }
            } title: {
                Text("Orbis").font(.system(size: 20, weight: .semibold))
            } trailing: { EmptyView() }
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 0) {
                        Image("OrbisMark").resizable().scaledToFit().frame(width: 52, height: 52)
                            .frame(width: 76, height: 76).neuSurface(inset: true, radius: 20)
                        Text("连接你的电脑").font(.system(size: 24, weight: .semibold)).padding(.top, 18)
                            .accessibilityAddTraits(.isHeader)
                        Text("在电脑端打开 Orbis 配对窗口，扫描二维码。")
                            .font(.system(size: 14)).foregroundStyle(OrbisPalette(scheme).secondary)
                            .multilineTextAlignment(.center).padding(.top, 12).padding(.bottom, 28)
                        OrbisActionButton(title: "扫码配对", symbol: "qrcode.viewfinder") {
                            codeFocused = false; validationError = nil; scannerOpen = true
                        }.disabled(store.isPairing)
                        HStack(spacing: 12) {
                            Rectangle().fill(OrbisPalette(scheme).outline).frame(height: 1)
                            Text("手动输入").font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize()
                            Rectangle().fill(OrbisPalette(scheme).outline).frame(height: 1)
                        }.padding(.vertical, 22)
                        Button { manualOpen.toggle() } label: {
                            HStack {
                                Image(systemName: "doc.on.clipboard")
                                Text("粘贴配对二维码内容").font(.system(size: 14, weight: .medium))
                                Spacer()
                                Image(systemName: manualOpen ? "chevron.up" : "chevron.down").font(.system(size: 12))
                            }.padding(16).frame(minHeight: 52)
                        }.buttonStyle(NeuButtonStyle(selected: manualOpen))
                        if manualOpen {
                            TextField("粘贴电脑端二维码的 JSON 内容", text: $code, axis: .vertical)
                                .font(.system(size: 13, design: .monospaced)).lineLimit(5...9)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().focused($codeFocused)
                                .orbisInput().padding(.top, 16).accessibilityLabel("配对二维码 JSON 内容")
                            Text("二维码包含建立安全连接所需的信息，单独的配对码无法完成配对。")
                                .font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10)
                            OrbisActionButton(title: "连接", symbol: "link") { submit(code) }
                                .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isPairing)
                                .padding(.top, 16)
                        }
                        if let validationError { OrbisNotice(text: validationError, error: true).padding(.top, 16) }
                        Label("端到端加密 · 配对信息保存在本机", systemImage: "lock.shield")
                            .font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary)
                            .padding(.top, 28)
                    }.frame(maxWidth: 430).padding(24).frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }.scrollDismissesKeyboard(.interactively)
            }
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .sheet(isPresented: $scannerOpen) {
                PairingScannerView { raw in scannerOpen = false; submit(raw) }.orbisSheet([.large])
            }
    }

    private func submit(_ raw: String) {
        do {
            _ = try PairingQR.parse(raw.trimmingCharacters(in: .whitespacesAndNewlines))
            validationError = nil; codeFocused = false; onCode(raw)
        } catch { validationError = error.localizedDescription }
    }
}

struct PairingScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let onCode: (String) -> Void
    @State private var failure: String?
    @State private var scannerID = UUID()

    var body: some View {
        VStack(spacing: 20) {
            OrbisPageHeader(title: "扫描配对二维码", back: { dismiss() }) { EmptyView() }
            Text("将电脑端二维码放入取景框").font(.system(size: 16, weight: .semibold))
            QRScannerRepresentable(onCode: { code in
                do { _ = try PairingQR.parse(code); onCode(code) }
                catch { failure = error.localizedDescription }
            }, onFailure: { failure = $0 })
                .id(scannerID).aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 20)).padding(6)
                .neuSurface(inset: true).padding(.horizontal, 24)
                .accessibilityLabel("二维码相机取景框")
            if let failure {
                OrbisNotice(text: failure, error: true).padding(.horizontal, 24)
                HStack(spacing: 12) {
                    OrbisActionButton(title: "重新扫描", symbol: "arrow.clockwise") { self.failure = nil; scannerID = UUID() }
                    OrbisActionButton(title: "相机设置", symbol: "gearshape") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }.padding(.horizontal, 24)
            }
            Text("仅在本机识别二维码，识别成功后自动连接。")
                .font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary).padding(.horizontal, 24)
            Spacer(minLength: 12)
            OrbisActionButton(title: "取消", action: { dismiss() }).padding(.horizontal, 24).padding(.bottom, 20)
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
    }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onFailure: (String) -> Void
    func makeUIViewController(context: Context) -> QRScannerController { QRScannerController(onCode: onCode, onFailure: onFailure) }
    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
    static func dismantleUIViewController(_ controller: QRScannerController, coordinator: ()) { controller.stop() }
}

private final class QRScannerController: UIViewController {
    private let capture: QRCapture
    private let onFailure: (String) -> Void
    private var preview: AVCaptureVideoPreviewLayer?

    init(onCode: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
        capture = QRCapture(onCode: onCode, onFailure: onFailure)
        self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let layer = AVCaptureVideoPreviewLayer(session: capture.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.viewIfLoaded?.window != nil else { return }
                if granted { self.capture.start() }
                else { self.onFailure("请在系统设置中允许相机权限，或返回粘贴配对内容。") }
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stop() }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    func stop() { capture.stop() }
}

/// AVCaptureSession configuration/start/stop can block; all of them run on the
/// same background queue, including stopping when the scanner is dismissed.
private final class QRCapture: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.orbising.orbis.camera")
    private let onCode: (String) -> Void
    private let onFailure: (String) -> Void
    private var configured = false
    private var active = false
    private var delivered = false

    init(onCode: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
        self.onCode = onCode
        self.onFailure = onFailure
    }

    func start() {
        queue.async { [self] in
            active = true
            do {
                if !configured {
                    session.beginConfiguration()
                    defer { session.commitConfiguration() }
                    guard let device = AVCaptureDevice.default(for: .video) else { throw PairingError.relay("当前设备没有可用相机，可返回粘贴配对内容。") }
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureMetadataOutput()
                    guard session.canAddInput(input), session.canAddOutput(output) else { throw PairingError.relay("无法启动相机，可返回粘贴配对内容。") }
                    session.addInput(input)
                    session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: queue)
                    output.metadataObjectTypes = [.qr]
                    configured = true
                }
                if active && !delivered && !session.isRunning { session.startRunning() }
            } catch {
                DispatchQueue.main.async { [onFailure] in onFailure(error.localizedDescription) }
            }
        }
    }

    func stop() {
        queue.async { [self] in
            active = false
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard active, !delivered, let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        delivered = true
        active = false
        session.stopRunning()
        DispatchQueue.main.async { [onCode] in onCode(code) }
    }
}
