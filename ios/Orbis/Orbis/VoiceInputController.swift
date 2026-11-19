import Foundation

/// IOS-VOICE-01: each recognition update is a replacement of the current utterance,
/// not an addition to it. Empty late results must not erase the last usable text.
struct VoiceDictationDraft: Equatable {
    let original: String
    private(set) var transcript = ""

    var text: String { replacingTranscript(with: transcript) }

    mutating func update(_ candidate: String) {
        let text = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { transcript = text }
    }

    func replacingTranscript(with text: String) -> String {
        guard !text.isEmpty else { return original }
        let separator = original.isEmpty || original.hasSuffix("\n") ? "" : "\n"
        return original + separator + text
    }
}

#if os(iOS)
import AVFoundation
import Observation
import Speech

@MainActor
@Observable
final class VoiceInputController {
    private(set) var isListening = false
    private(set) var isFinishing = false
    private(set) var draft: VoiceDictationDraft?
    private(set) var draftRevision = 0
    private(set) var errorMessage: String?
    var isActive: Bool { draft != nil }

    private var recognitionID: UUID?
    private var authorizationTask: Task<Void, Never>?
    private var finishTimeout: Task<Void, Never>?
    private var audioSessionActive = false
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var onComplete: ((VoiceDictationDraft) -> Void)?

    func start(draft original: String, onComplete: @escaping (VoiceDictationDraft) -> Void) {
        guard !isActive else { return }
        let id = UUID()
        recognitionID = id
        draft = VoiceDictationDraft(original: original)
        errorMessage = nil
        self.onComplete = onComplete

        authorizationTask = Task { [weak self] in
            guard let self else { return }
            let speechStatus = await Self.requestSpeechAuthorization()
            guard !Task.isCancelled else { return }
            guard speechStatus == .authorized else {
                self.fail(speechStatus == .denied || speechStatus == .restricted
                          ? "请在系统设置中允许麦克风和语音识别"
                          : "语音识别暂不可用")
                return
            }

            let microphoneGranted = await Self.requestMicrophonePermission()
            guard !Task.isCancelled else { return }
            guard microphoneGranted else {
                self.fail("请在系统设置中允许麦克风和语音识别")
                return
            }

            do {
                try self.beginRecognition(id: id)
            } catch {
                self.fail("语音输入失败，请重试")
            }
        }
    }

    @discardableResult
    func stop() -> VoiceDictationDraft? {
        guard isListening, let id = recognitionID else { return nil }
        isListening = false
        isFinishing = true
        stopCapture()
        recognitionRequest?.endAudio()
        // Give Speech a brief chance to deliver its final revision. Some sessions
        // never send a terminal callback; keep the last usable text in that case.
        finishTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            guard let self, self.recognitionID == id else { return }
            self.completeRecognition(failed: false)
        }
        return draft
    }

    func cancel() {
        recognitionID = nil
        onComplete = nil
        authorizationTask?.cancel()
        authorizationTask = nil
        finishTimeout?.cancel()
        finishTimeout = nil
        stopCapture()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        recognizer = nil
        if draft?.transcript.isEmpty == false { draftRevision &+= 1 }
        draft = nil
        isListening = false
        isFinishing = false
        if audioSessionActive {
            audioSessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    private func stopCapture() {
        guard let engine = audioEngine else { return }
        audioEngine = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }

    private func beginRecognition(id: UUID) throws {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
            fail("此设备暂不支持语音识别")
            return
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Prefer private, local processing whenever this locale supports it. The system may
        // otherwise use Apple's speech-recognition service; Info.plist explains this to users.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        recognitionRequest = request

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true)
        audioSessionActive = true

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw VoiceInputFailure.noInput }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        audioEngine = engine
        try engine.start()
        isListening = true

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal == true
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.recognitionID == id, var updated = self.draft else { return }
                if let text {
                    updated.update(text)
                    if updated != self.draft {
                        self.draft = updated
                        self.draftRevision &+= 1
                    }
                }
                if isFinal || failed { self.completeRecognition(failed: failed) }
            }
        }
    }

    private func completeRecognition(failed: Bool) {
        let completed = draft
        let callback = onComplete
        cancel()
        if let completed, !completed.transcript.isEmpty {
            callback?(completed)
        } else if failed {
            errorMessage = "未听清，请再试一次"
        }
    }

    private func fail(_ message: String) {
        cancel()
        errorMessage = message
    }

    private static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private static func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}

private enum VoiceInputFailure: Error {
    case noInput
}
#endif
