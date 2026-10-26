package expo.modules.voiceassistant

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle
import android.os.PowerManager
import android.util.Log

/**
 * Catches assist, voice command and headset voice search intents and forwards to the app.
 * Also the route [SessionResume] uses to bring the Claude app back after a signal drop,
 * since this is the activity that already knows how to get past the lock screen.
 */
class AssistTrampolineActivity : Activity() {
  private val resume: Boolean get() = intent?.getBooleanExtra(EXTRA_RESUME, false) == true

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Log.i("VoiceClaude", if (resume) "Resume launch" else "Assist intent: ${intent?.action}")

    // A resume starts from the background with the screen off, so make sure it lights up.
    if (resume) wakeScreen()

    // The Claude app can't show over the lock screen, so unlock first. Without a PIN prompt
    // (e.g. Extend Unlock trusting the earbuds) this happens silently with the phone in a pocket.
    val keyguard = getSystemService(KeyguardManager::class.java)
    if ((resume || EarbudTarget.get(this) == EarbudTarget.CLAUDE_APP) && keyguard.isKeyguardLocked) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
      keyguard.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = fireAndFinish()
        override fun onDismissError() = giveUp("error")
        override fun onDismissCancelled() = giveUp("cancelled")
      })
      return
    }
    fireAndFinish()
  }

  private fun fireAndFinish() {
    if (resume) {
      EarbudTarget.openClaudeAppForResume(this) { startActivity(it) }
    } else {
      AssistTrigger.fire(this) { startActivity(it) }
    }
    finish()
  }

  private fun giveUp(reason: String) {
    Log.w("VoiceClaude", "Could not dismiss the lock screen ($reason)")
    finish()
  }

  // The bright/wake-up flags are deprecated but still the only way to light the screen
  // from a background-started activity when turnScreenOn alone doesn't.
  @Suppress("DEPRECATION")
  private fun wakeScreen() {
    runCatching {
      getSystemService(PowerManager::class.java)
        .newWakeLock(
          PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
          "VoiceClaude:resume"
        )
        .acquire(WAKE_LOCK_MS)
    }.onFailure { Log.w("VoiceClaude", "Could not acquire the wake lock", it) }
  }

  companion object {
    const val EXTRA_RESUME = "resume"
    private const val WAKE_LOCK_MS = 10_000L
  }
}
