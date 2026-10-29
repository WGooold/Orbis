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
                Text("Orbis").font(.orbisTitle())
            } trailing: { EmptyView() }
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 0) {
                        Image("OrbisMark").resizable().scaledToFit().frame(width: 52, height: 52)
                            .frame(width: 76, height: 76).neuSurface(inset: true, radius: 20)
                        Text("连接你的电脑").font(.orbisTitle()).padding(.top, 18).padding(.bottom, 28)
                            .accessibilityAddTraits(.isHeader)
                        OrbisActionButton(title: "扫码配对", symbol: "qrcode.viewfinder") {
                            codeFocused = false; validationError = nil; scannerOpen = true
                        }.disabled(store.isPairing)
                        HStack(spacing: 12) {
                            OrbisPalette(scheme).well.frame(height: 2).clipShape(Capsule())
                            Text("手动输入").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary).fixedSize()
                            OrbisPalette(scheme).well.frame(height: 2).clipShape(Capsule())
                        }.padding(.vertical, 22)
                        Button { manualOpen.toggle() } label: {
                            HStack {
                                Image(systemName: "doc.on.clipboard")
                                Text("粘贴配对二维码内容").fontWeight(.medium)
                                Spacer()
                                Image(systemName: "chevron.down").imageScale(.small)
                                    .rotationEffect(.degrees(manualOpen ? 180 : 0)).animation(.orbisCollapse, value: manualOpen)
                            }.font(.orbisBody()).padding(16).frame(minHeight: 52)
                        }.buttonStyle(NeuButtonStyle(selected: manualOpen))
                        OrbisCollapse(expanded: manualOpen) {
                            VStack(spacing: 16) {
                                TextField("粘贴电脑端二维码的 JSON 内容", text: $code, axis: .vertical)
                                    .font(.orbisLabel(mono: true)).lineLimit(5...9)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().focused($codeFocused)
                                    .orbisInput(focused: codeFocused).accessibilityLabel("配对二维码 JSON 内容")
                                OrbisActionButton(title: "连接", symbol: "link") { submit(code) }
                                    .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isPairing)
                            }.padding(.top, 16).padding(.horizontal, 4).padding(.bottom, 4)
                        }
                        if let validationError { OrbisNotice(text: validationError, error: true).padding(.top, 16) }
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
            QRScannerRepresentable(onCode: { code in
                do { _ = try PairingQR.parse(code); onCode(code) }
                catch { failure = error.localizedDescription }
            }, onFailure: { failure = $0 })
                .id(scannerID).aspectRatio(1, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .neuSurface(inset: true, radius: 20, padding: 6).padding(.horizontal, 24)
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
        view.backgroundColor = .clear
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
