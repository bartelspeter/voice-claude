package expo.modules.voiceassistant

import android.content.Context
import android.content.Intent

/**
 * Hand-off point between the Android assistant entry points and JS.
 * A trigger is remembered as pending so a cold start can pick it up once JS is ready.
 */
object AssistTrigger {
  @Volatile private var pending = false
  @Volatile var listener: (() -> Unit)? = null

  fun fire(context: Context, launch: (Intent) -> Unit) {
    // A press means the user is starting fresh, online or not.
    SessionResume.onNewChat("earbud press")
    if (EarbudTarget.openClaudeAppIfTarget(context, launch)) return
    pending = true
    listener?.invoke()
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { intent ->
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      launch(intent)
    }
  }

  fun consume(): Boolean {
    val wasPending = pending
    pending = false
    return wasPending
  }
}
