package dev.pi.remote

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.annotation.SuppressLint
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.draw.clip
import dev.pi.remote.NeumorphDialog as AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private val pairingJson = Json { ignoreUnknownKeys = true }

@Serializable
private data class PairingQrPayload(
    val version: Int,
    val relayUrl: String,
    val code: String,
)

data class PairingDetails(
    val relayUrl: String,
    val code: String,
)

internal fun parsePairingQrPayload(raw: String): PairingDetails? {
    val payload = runCatching {
        pairingJson.decodeFromString<PairingQrPayload>(raw)
    }.getOrNull() ?: return null
    if (payload.version != 1 || !isSupportedRelayUrl(payload.relayUrl)) return null
    if (!payload.code.matches(Regex("^[A-Z0-9_-]{4,128}$"))) return null
    return PairingDetails(payload.relayUrl.trim(), payload.code.trim())
}

/**
 * v2 配对二维码（spec §4.2）：带 E2E 密码学材料（hostPub + 一次性 psk）。
 * 解析立即验长度；有效期由调用方结合本地时间判定（给出更具体的提示）。
 */
@Serializable
data class PairingQrV2(
    val relayUrl: String,
    val code: String,
    val hostId: String,
    val hostName: String,
    val hostPub: String,
    val psk: String,
    val exp: Long,
    val lan: List<LanEndpoint> = emptyList(),
)

internal fun parsePairingQrV2(raw: String): PairingQrV2? {
    val payload = runCatching {
        pairingJson.decodeFromString<PairingQrV2Payload>(raw)
    }.getOrNull() ?: return null
    if (payload.v != 2 || !isSupportedRelayUrl(payload.relayUrl)) return null
    if (!payload.code.matches(Regex("^[A-Z0-9_-]{4,128}$"))) return null
    val materialOk = runCatching {
        Crypto.fromBase64UrlFixed(payload.hostPub, Crypto.X25519_KEY_BYTES, "hostPub")
        Crypto.fromBase64UrlFixed(payload.psk, Crypto.SYMMETRIC_KEY_BYTES, "psk")
    }.isSuccess
    if (!materialOk) return null
    return PairingQrV2(
        relayUrl = payload.relayUrl.trim(),
        code = payload.code.trim(),
        hostId = payload.hostId.trim(),
        hostName = payload.hostName,
        hostPub = payload.hostPub,
        psk = payload.psk,
        exp = payload.exp,
        lan = payload.lan.filter { it.url() != null }.distinct().take(16),
    )
}

@Serializable
private data class PairingQrV2Payload(
    val v: Int,
    val relayUrl: String,
    val code: String,
    val hostId: String,
    val hostName: String,
    val hostPub: String,
    val psk: String,
    val exp: Long,
    val lan: List<LanEndpoint> = emptyList(),
)

@Composable
fun QrScannerDialog(
    onPayload: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val onPayloadUpdated by rememberUpdatedState(onPayload)
    var hasPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasPermission = granted }

    LaunchedEffect(Unit) {
        if (!hasPermission) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("扫描配对二维码") },
        text = {
            if (hasPermission) {
                QrCameraPreview(
                    context = context,
                    lifecycleOwner = lifecycleOwner,
                    onPayload = onPayloadUpdated,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("需要相机权限才能扫描配对二维码。")
                    NeumorphActionButton(
                        onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                        text = "允许相机权限",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = { NeumorphTextButton(text = "取消", onClick = onDismiss) },
    )
}

@SuppressLint("UnsafeOptInUsageError")
@Composable
private fun QrCameraPreview(
    context: Context,
    lifecycleOwner: androidx.lifecycle.LifecycleOwner,
    onPayload: (String) -> Unit,
) {
    val previewView = remember { PreviewView(context) }
    val onPayloadUpdated by rememberUpdatedState(onPayload)

    DisposableEffect(previewView, lifecycleOwner) {
        val cameraExecutor = Executors.newSingleThreadExecutor()
        val delivered = AtomicBoolean(false)
        val disposed = AtomicBoolean(false)
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(cameraExecutor) { imageProxy ->
            val mediaImage = imageProxy.image
            if (mediaImage == null || delivered.get()) {
                imageProxy.close()
                return@setAnalyzer
            }
            val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    val raw = barcodes.firstOrNull()?.rawValue
                    if (raw != null && delivered.compareAndSet(false, true)) {
                        ContextCompat.getMainExecutor(context).execute { onPayloadUpdated(raw) }
                    }
                }
                .addOnCompleteListener { imageProxy.close() }
        }

        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        val mainExecutor = ContextCompat.getMainExecutor(context)
        var cameraProvider: ProcessCameraProvider? = null
        cameraProviderFuture.addListener({
            if (disposed.get()) return@addListener
            runCatching {
                cameraProvider = cameraProviderFuture.get()
                if (disposed.get()) return@runCatching
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                cameraProvider?.unbindAll()
                cameraProvider?.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis,
                )
            }
        }, mainExecutor)

        onDispose {
            disposed.set(true)
            analysis.clearAnalyzer()
            cameraProvider?.unbindAll()
            scanner.close()
            cameraExecutor.shutdown()
        }
    }

    NeumorphSurface(style = NeumorphStyle.Pressed, shape = RemoteUi.CardShape) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxWidth().padding(8.dp).aspectRatio(1f).clip(RemoteUi.ControlShape),
        )
    }
}
