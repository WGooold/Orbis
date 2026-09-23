package dev.pi.remote

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

class InteractionNotifier(private val context: Context) {
    private val notifications = context.getSystemService(NotificationManager::class.java)

    init {
        notifications.createNotificationChannel(NotificationChannel(
            CHANNEL_ID,
            "Pi 交互请求",
            NotificationManager.IMPORTANCE_HIGH,
        ))
    }

    fun show(runtimeName: String, request: PendingInteraction) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        val intent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_orbis)
            .setContentTitle(request.title)
            .setContentText("$runtimeName • ${request.extensionId}")
            .setContentIntent(intent)
            .setAutoCancel(true)
            .build()
        notifications.notify(request.requestId.hashCode(), notification)
    }

    private companion object {
        const val CHANNEL_ID = "pi_remote_interactions"
    }
}
