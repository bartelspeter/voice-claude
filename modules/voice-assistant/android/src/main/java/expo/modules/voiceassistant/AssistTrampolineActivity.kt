package expo.modules.voiceassistant

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle
import android.util.Log

/** Catches assist, voice command and headset voice search intents and forwards to the app. */
class AssistTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Log.i("VoiceClaude", "Assist intent: ${intent?.action}")

    // The Claude app can't show over the lock screen, so unlock first. Without a PIN prompt
    // (e.g. Extend Unlock trusting the earbuds) this happens silently with the phone in a pocket.
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (EarbudTarget.get(this) == EarbudTarget.CLAUDE_APP && keyguard.isKeyguardLocked) {
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
    AssistTrigger.fire(this) { startActivity(it) }
    finish()
  }

  private fun giveUp(reason: String) {
    Log.w("VoiceClaude", "Could not dismiss the lock screen ($reason)")
    finish()
  }
}
