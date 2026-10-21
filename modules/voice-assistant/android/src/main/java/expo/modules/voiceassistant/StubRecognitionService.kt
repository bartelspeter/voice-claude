package expo.modules.voiceassistant

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** Required for the assistant role. Speech recognition happens in JS (Deepgram). */
class StubRecognitionService : RecognitionService() {
  override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
    listener?.error(SpeechRecognizer.ERROR_CLIENT)
  }

  override fun onCancel(listener: Callback?) {}

  override fun onStopListening(listener: Callback?) {}
}
