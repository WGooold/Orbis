import AVFoundation
import Observation
import Speech

@MainActor
@Observable
final class VoiceInputController {
    private(set) var isListening = false
    private(set) var isFinishing = false
    private(set) var transcript = ""
    private(set) var errorMessage: String?

    private var authorizationTask: Task<Void, Never>?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var onComplete: ((String) -> Void)?

    func start(onComplete: @escaping (String) -> Void) {
        guard !isListening, !isFinishing, authorizationTask == nil else { return }
        transcript = ""
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
                try self.beginRecognition()
            } catch {
                self.fail("语音输入失败，请重试")
            }
        }
    }

    func stop() {
        authorizationTask?.cancel()
        authorizationTask = nil
        guard isListening else { return }
        isListening = false
        isFinishing = true
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        deactivateAudioSession()
    }

    func cancel() {
        authorizationTask?.cancel()
        authorizationTask = nil
        isListening = false
        isFinishing = false
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine = nil
        recognizer = nil
        onComplete = nil
        deactivateAudioSession()
    }

    private func beginRecognition() throws {
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
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.completeRecognition(error: nil) }
                }
                if let error, !self.isFinishing {
                    self.completeRecognition(error: error)
                } else if let error, self.isFinishing {
                    // End-of-audio can arrive with a cancellation-like error after a successful
                    // partial result. Keep that text instead of discarding a user's dictation.
                    self.completeRecognition(error: self.transcript.isEmpty ? error : nil)
                }
            }
        }
    }

    private func completeRecognition(error: Error?) {
        guard isListening || isFinishing else { return }
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil
        recognizer = nil
        isListening = false
        isFinishing = false
        authorizationTask = nil
        deactivateAudioSession()

        let recognizedText = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !recognizedText.isEmpty {
            onComplete?(recognizedText)
        } else if error != nil {
            errorMessage = "未听清，请再试一次"
        }
        onComplete = nil
    }

    private func fail(_ message: String) {
        errorMessage = message
        isListening = false
        isFinishing = false
        authorizationTask = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        recognizer = nil
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        onComplete = nil
        deactivateAudioSession()
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
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
