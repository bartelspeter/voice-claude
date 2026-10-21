package expo.modules.voiceassistant

import android.service.voice.VoiceInteractionService

class AssistInteractionService : VoiceInteractionService() {
  override fun onLaunchVoiceAssistFromKeyguard() {
    AssistTrigger.fire(this) { startActivity(it) }
  }
}
