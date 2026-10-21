package expo.modules.voiceassistant

import android.app.Activity
import android.os.Bundle
import android.util.Log

/** Catches assist, voice command and headset voice search intents and forwards to the app. */
class AssistTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Log.i("VoiceClaude", "Assist intent: ${intent?.action}")
    AssistTrigger.fire(this) { startActivity(it) }
    finish()
  }
}
