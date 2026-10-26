package expo.modules.voiceassistant

import android.app.ForegroundServiceStartNotAllowedException
import android.app.InvalidForegroundServiceTypeException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/** Foreground service so the mic keeps working while the screen is off mid-conversation. */
class ConversationService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Voice conversation", NotificationManager.IMPORTANCE_LOW)
    )
    val tapIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
      android.app.PendingIntent.getActivity(this, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE)
    }
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Claude is listening")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentIntent(tapIntent)
      .setOngoing(true)
      .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Android 14+ refuses a microphone foreground service started while the app is not visible
      // (a pocket start with the screen off) unless the app is exempt from battery optimisation.
      // Uncaught, this took the whole process down; instead tell JS so it can light the screen
      // and try once more, or explain the exemption to the user.
      if (!isStartRefusal(e)) throw e
      val reason = "${e.javaClass.simpleName}: ${e.message}"
      Log.e("VoiceClaude", "Conversation service could not go foreground: $reason")
      stopSelf()
      onStartFailed?.invoke(reason)
    }
    return START_NOT_STICKY
  }

  private fun isStartRefusal(e: Exception): Boolean =
    e is SecurityException ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && e is ForegroundServiceStartNotAllowedException) ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && e is InvalidForegroundServiceTypeException)

  companion object {
    private const val CHANNEL_ID = "voice-conversation"
    private const val NOTIFICATION_ID = 4242

    /** Set by the module while JS is alive; called with the reason when startForeground is refused. */
    @Volatile var onStartFailed: ((String) -> Unit)? = null
  }
}
