package com.orbising.orbis

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
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
        pairingJson.decodeFromString<PairingQrPayload>(raw.trim())
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
        pairingJson.decodeFromString<PairingQrV2Payload>(raw.trim())
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

/** Returns the rejection reason, or null once the payload started pairing. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QrScannerSheet(
    onPayload: (String) -> String?,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val onPayloadUpdated by rememberUpdatedState(onPayload)
    var hasPermission by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var error by remember { mutableStateOf<String?>(null) }
    var scannerID by remember { mutableIntStateOf(0) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasPermission = granted }
    // 电脑屏幕上的二维码、别人转发到聊天里的截图都用这条路：不用对着屏幕扫。
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
    }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        error = null
        executor.execute {
            val image = runCatching { InputImage.fromFilePath(context, uri) }.getOrNull()
            val read = image?.let { input ->
                runCatching { com.google.android.gms.tasks.Tasks.await(scanner.process(input)) }.getOrNull()
            }
            val raw = read?.firstNotNullOfOrNull { it.rawValue }
            ContextCompat.getMainExecutor(context).execute {
                if (raw == null) error = L10n.tr("这张图片里没有找到二维码")
                else error = onPayloadUpdated(raw)
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose { scanner.close(); executor.shutdown() }
    }

    LaunchedEffect(Unit) {
        if (!hasPermission) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    fun accept(raw: String) {
        error = onPayloadUpdated(raw)
    }

    val failure = error ?: if (hasPermission) null
        else L10n.tr("请在系统设置中允许相机权限，或返回粘贴配对内容。")

    OrbisBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 8.dp, end = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                NeumorphIconButton(
                    onClick = sheetCloseAction(onDismiss),
                    icon = OrbisSymbols.Close,
                    contentDescription = L10n.tr("关闭"),
                )
                Text(L10n.tr("扫描配对二维码"), style = MaterialTheme.typography.titleLarge)
            }
            Column(
                Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                    .padding(start = 24.dp, top = 20.dp, end = 24.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                if (hasPermission) {
                    key(scannerID) {
                        QrCameraPreview(context, lifecycleOwner, onPayload = ::accept)
                    }
                }
                if (failure != null) {
                    PairingNotice(failure)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        NeumorphActionButton(
                            onClick = {
                                error = null
                                if (hasPermission) scannerID++
                                else permissionLauncher.launch(Manifest.permission.CAMERA)
                            },
                            text = L10n.tr("重新扫描"),
                            icon = OrbisSymbols.Refresh,
                            modifier = Modifier.weight(1f),
                        )
                        NeumorphActionButton(
                            onClick = { openAppSettings(context) },
                            text = L10n.tr("相机设置"),
                            icon = OrbisSymbols.Settings,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Row(
                    Modifier.fillMaxWidth().clip(RemoteUi.ControlShape).clickable {
                        imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }.padding(vertical = 12.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.PhotoLibrary, contentDescription = null,
                        modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurface)
                    Spacer(Modifier.width(8.dp))
                    Text(L10n.tr("从相册选图"), style = MaterialTheme.typography.bodyLarge)
                }
            }
            NeumorphActionButton(
                onClick = sheetCloseAction(onDismiss),
                text = L10n.tr("取消"),
                modifier = Modifier.fillMaxWidth()
                    .padding(start = 24.dp, top = 16.dp, end = 24.dp, bottom = 20.dp),
            )
        }
    }
}

private fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", context.packageName, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

/** One raised notice for pairing failures, shared by the entry page and the scanner. */
@Composable
internal fun PairingNotice(text: String, error: Boolean = true) {
    NeumorphSurface(Modifier.fillMaxWidth(), shape = RemoteUi.ControlShape, contentPadding = 16.dp) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Icon(
                if (error) OrbisSymbols.Error else OrbisSymbols.Info,
                contentDescription = null,
                tint = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
            Text(text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        }
    }
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

    NeumorphSurface(style = NeumorphStyle.Pressed, shape = RoundedCornerShape(20.dp), contentPadding = 6.dp) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(14.dp))
                .semantics { contentDescription = L10n.tr("二维码相机取景框") },
        )
    }
}
