package com.orbising.orbis

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.InsertDriveFile
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * ADR-0049 §6.1：等待上传的消息在气泡内显示附件。图片显示缩略图，其他文件显示图标；文件名按 S09 保留扩展名，
 * 下方是与输入框附件条相同的上传状态与进度。只读：重试 / 放回 / 删除在气泡下方的操作区（与 iOS `PendingAttachments` 一致）。
 */
@Composable
internal fun PendingAttachments(uploads: List<UploadTask>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (upload in uploads) {
            val failed = upload.status == "failed"
            val progress = uploadProgressText(upload)
            Row(
                Modifier.testTag("pending-attachment-${upload.taskId}")
                    .semantics(mergeDescendants = true) { contentDescription = "${upload.displayName}，$progress" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AttachmentThumbnail(upload)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    FileNameText(upload.displayName, style = MaterialTheme.typography.labelMedium)
                    Text(progress, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** 36dp 方形缩略图：手机上的图片按需降采样解码，其他文件或解码失败显示文件图标。 */
@Composable
private fun AttachmentThumbnail(upload: UploadTask) {
    val context = LocalContext.current
    val image by produceState<ImageBitmap?>(null, upload.sourceUri) {
        value = withContext(Dispatchers.IO) { decodeAttachmentThumbnail(context, upload) }
    }
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        val bitmap = image
        if (bitmap != null) {
            Image(bitmap, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().testTag("pending-attachment-thumbnail"))
        } else {
            Icon(Icons.Rounded.InsertDriveFile, contentDescription = null, modifier = Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

internal fun attachmentIsImage(upload: UploadTask): Boolean {
    val type = upload.mimeType ?: MimeTypeMap.getSingleton()
        .getMimeTypeFromExtension(upload.displayName.substringAfterLast('.', "").lowercase())
    return type?.startsWith("image/") == true
}

private fun decodeAttachmentThumbnail(context: Context, upload: UploadTask, maxPixels: Int = 120): ImageBitmap? {
    if (!attachmentIsImage(upload)) return null
    return runCatching {
        val uri = Uri.parse(upload.sourceUri)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxPixels && bounds.outHeight / (sample * 2) >= maxPixels) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }?.asImageBitmap()
    }.getOrNull()
}
