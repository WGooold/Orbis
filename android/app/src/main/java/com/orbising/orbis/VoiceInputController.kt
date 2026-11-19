package com.orbising.orbis

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

internal enum class VoiceCapturePhase { Idle, Listening, Finishing }

/** Owns one system speech-recognition session for the chat composer. */
internal class VoiceInputController(context: Context) : RecognitionListener {
    companion object {
        fun hasOnDeviceRecognition(context: Context): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    }
    private val appContext = context.applicationContext
    private var recognizer: SpeechRecognizer? = null
    private var onComplete: ((String) -> Unit)? = null

    var phase by mutableStateOf(VoiceCapturePhase.Idle)
        private set
    var transcript by mutableStateOf("")
        private set
    var errorKey by mutableStateOf<String?>(null)
        private set
    var isOnDevice by mutableStateOf(false)
        private set

    fun start(onComplete: (String) -> Unit) {
        if (phase != VoiceCapturePhase.Idle) return
        transcript = ""
        errorKey = null
        this.onComplete = onComplete

        try {
            isOnDevice = hasOnDeviceRecognition(appContext)
            recognizer = if (isOnDevice) {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
            } else {
                SpeechRecognizer.createSpeechRecognizer(appContext)
            }.also { it.setRecognitionListener(this) }

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                if (!isOnDevice) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            }
            phase = VoiceCapturePhase.Listening
            recognizer?.startListening(intent)
        } catch (_: RuntimeException) {
            finish(error = "语音识别暂不可用")
        }
    }

    fun stop() {
        if (phase != VoiceCapturePhase.Listening) return
        phase = VoiceCapturePhase.Finishing
        try {
            recognizer?.stopListening()
        } catch (_: RuntimeException) {
            finish(error = "语音输入失败，请重试")
        }
    }

    fun destroy() {
        try {
            recognizer?.cancel()
            recognizer?.destroy()
        } catch (_: RuntimeException) {
            // The recognition service may already have disconnected during Activity teardown.
        }
        recognizer = null
        onComplete = null
        phase = VoiceCapturePhase.Idle
        transcript = ""
    }

    override fun onReadyForSpeech(params: Bundle?) { phase = VoiceCapturePhase.Listening }
    override fun onBeginningOfSpeech() { phase = VoiceCapturePhase.Listening }
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() { phase = VoiceCapturePhase.Finishing }
    override fun onEvent(eventType: Int, params: Bundle?) = Unit

    override fun onPartialResults(partialResults: Bundle?) {
        transcript = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull().orEmpty()
    }

    override fun onResults(results: Bundle?) {
        val result = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()?.takeIf(String::isNotBlank) ?: transcript
        finish(result = result)
    }

    override fun onError(error: Int) {
        val partial = transcript.trim()
        if (partial.isNotEmpty()) {
            finish(result = partial)
            return
        }
        val message = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "未听清，请再试一次"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "请在系统设置中允许麦克风权限"
            else -> "语音输入失败，请重试"
        }
        finish(error = message)
    }

    private fun finish(result: String? = null, error: String? = null) {
        val recognized = result?.trim().orEmpty()
        phase = VoiceCapturePhase.Idle
        transcript = recognized
        errorKey = error?.takeIf { recognized.isEmpty() }
        if (recognized.isNotEmpty()) onComplete?.invoke(recognized)
        onComplete = null
        try {
            recognizer?.destroy()
        } catch (_: RuntimeException) {
            // Ignore service teardown races.
        }
        recognizer = null
    }
}
