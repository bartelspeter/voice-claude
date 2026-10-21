package expo.modules.voiceassistant

import android.app.Activity
import android.os.Bundle

/** Catches ACTION_ASSIST / ACTION_VOICE_COMMAND and forwards to the app. */
class AssistTrampolineActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    AssistTrigger.fire(this) { startActivity(it) }
    finish()
  }
}
