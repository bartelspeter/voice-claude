package expo.modules.voiceassistant

import android.content.Context
import android.media.AudioAttributes
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

/**
 * Text-to-speech owned by VoiceAssistantModule (this app used to use expo-speech).
 *
 * expo-speech shut its TextToSpeech down in OnActivityDestroys and, being a `lazy`, never made a
 * new one. This app runs conversations from a foreground service with the activity behind the
 * keyguard or already destroyed, so once the activity had gone every later speak() logged
 * "not bound to TTS engine", no done/error event reached JS and the SentenceSpeaker waited
 * forever. This engine lives as long as the module (the React host) and is only shut down from
 * the module's OnDestroy. If it fails to bind, goes away or rejects an utterance it is recreated
 * once and that utterance retried; only when that fails too does the utterance get an error.
 *
 * Per utterance id JS gets onSpeechStart and then exactly one terminal event: onSpeechDone,
 * onSpeechStopped (stop() interrupted or discarded it) or onSpeechError. Terminal events are
 * deduplicated here, so a late callback from a replaced engine is never forwarded.
 *
 * All methods are safe to call from any thread; engine callbacks arrive on binder threads.
 */
class Speech(context: Context, private val emit: (event: String, id: String) -> Unit) {
  private enum class State { PENDING, READY, FAILED }

  private class Utterance(val id: String, val text: String, val language: String) {
    /** Set once the engine has been recreated for this utterance; a second failure is final. */
    var retried = false
  }

  private val context = context.applicationContext
  private val handler = Handler(Looper.getMainLooper())

  private var engine: TextToSpeech? = null
  /** Bumped per engine instance so an init callback from a replaced engine is ignored. */
  private var engineSeq = 0
  private var state = State.PENDING
  /** Utterances waiting for the engine to bind. */
  private val queue = ArrayDeque<Utterance>()
  /** Ids handed to the engine whose terminal event hasn't gone out yet. */
  private val inFlight = LinkedHashSet<String>()

  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String) {
      val live = synchronized(this@Speech) { utteranceId in inFlight }
      if (live) emit(EVENT_START, utteranceId)
    }

    override fun onDone(utteranceId: String) = finish(utteranceId, EVENT_DONE)

    override fun onStop(utteranceId: String, interrupted: Boolean) = finish(utteranceId, EVENT_STOPPED)

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String) = finish(utteranceId, EVENT_ERROR)

    override fun onError(utteranceId: String, errorCode: Int) {
      Log.w(TAG, "TTS utterance $utteranceId failed (code $errorCode)")
      finish(utteranceId, EVENT_ERROR)
    }
  }

  /** Queues `text` (QUEUE_ADD) in `language`, a BCP 47 tag such as "en-US"; binds the engine on first use. */
  @Synchronized
  fun speak(id: String, text: String, language: String) {
    val utterance = Utterance(id, text, language)
    when (state) {
      State.READY -> speakOut(utterance)
      State.PENDING -> {
        queue.addLast(utterance)
        if (engine == null) createEngine()
      }
      State.FAILED -> {
        // The one recreation this utterance gets; a second init failure sends its error.
        utterance.retried = true
        queue.addLast(utterance)
        createEngine()
      }
    }
  }

  /**
   * Stops the current utterance and drops everything queued. Every affected id gets
   * onSpeechStopped from here, so JS is told even when the engine isn't bound and its own
   * onStop callbacks never come; the engine's callbacks for those ids are then ignored.
   */
  @Synchronized
  fun stop() {
    engine?.stop()
    val stopped = inFlight.toList() + queue.map { it.id }
    inFlight.clear()
    queue.clear()
    for (id in stopped) emit(EVENT_STOPPED, id)
  }

  @Synchronized
  fun isSpeaking(): Boolean = queue.isNotEmpty() || engine?.isSpeaking == true

  /** Releases the engine. Only for the module's OnDestroy; nothing is spoken after this. */
  @Synchronized
  fun shutdown() {
    engineSeq++
    engine?.shutdown()
    engine = null
    state = State.FAILED
    queue.clear()
    inFlight.clear()
    Log.i(TAG, "TTS engine shut down")
  }

  private fun createEngine() {
    engine?.shutdown()
    engine = null
    val seq = ++engineSeq
    state = State.PENDING
    Log.i(TAG, if (seq == 1) "Binding TTS engine" else "Recreating TTS engine (#$seq)")
    // With no engine installed the init callback runs synchronously inside the constructor, so
    // onInit must not rely on `engine` being assigned yet.
    val tts = TextToSpeech(context) { status -> onInit(seq, status) }
    tts.setAudioAttributes(attributes)
    tts.setOnUtteranceProgressListener(progressListener)
    engine = tts
  }

  @Synchronized
  private fun onInit(seq: Int, status: Int) {
    if (seq != engineSeq) return // a replaced or shut-down engine
    if (status == TextToSpeech.SUCCESS) {
      state = State.READY
      Log.i(TAG, "TTS engine bound (${engine?.defaultEngine ?: "engine pending"})")
      while (queue.isNotEmpty() && state == State.READY) speakOut(queue.removeFirst())
      return
    }
    state = State.FAILED
    Log.w(TAG, "TTS engine failed to bind (status $status)")
    val (exhausted, retriable) = queue.partition { it.retried }
    queue.clear()
    for (utterance in exhausted) emit(EVENT_ERROR, utterance.id)
    if (retriable.isEmpty()) return
    for (utterance in retriable) {
      utterance.retried = true
      queue.addLast(utterance)
    }
    // Off the callback so a synchronous failure in the constructor can't recurse.
    handler.post {
      synchronized(this) { if (engineSeq == seq && state == State.FAILED) createEngine() }
    }
  }

  /** Hands one utterance to a READY engine; on ERROR recreates the engine once and requeues it. */
  private fun speakOut(utterance: Utterance) {
    val tts = engine
    if (tts == null) {
      requeueAfterFailure(utterance, "engine gone")
      return
    }
    // A language the engine lacks is still spoken, in whatever voice it has.
    tts.setLanguage(Locale.forLanguageTag(utterance.language))
    inFlight.add(utterance.id)
    if (tts.speak(utterance.text, TextToSpeech.QUEUE_ADD, null, utterance.id) == TextToSpeech.ERROR) {
      inFlight.remove(utterance.id)
      requeueAfterFailure(utterance, "speak returned ERROR")
    }
  }

  private fun requeueAfterFailure(utterance: Utterance, reason: String) {
    if (utterance.retried) {
      Log.w(TAG, "TTS utterance ${utterance.id} failed again ($reason), giving up")
      emit(EVENT_ERROR, utterance.id)
      return
    }
    Log.w(TAG, "TTS utterance ${utterance.id} failed ($reason), recreating the engine")
    utterance.retried = true
    // Anything the dead engine still held will never report back; fail it so JS doesn't wait.
    val lost = inFlight.toList()
    inFlight.clear()
    for (id in lost) emit(EVENT_ERROR, id)
    queue.addFirst(utterance) // ahead of anything queued after it, so sentences keep their order
    createEngine()
  }

  private fun finish(id: String, event: String) {
    val live = synchronized(this) { inFlight.remove(id) }
    if (live) emit(event, id)
  }

  companion object {
    private const val TAG = "VoiceClaude"
    const val EVENT_START = "onSpeechStart"
    const val EVENT_DONE = "onSpeechDone"
    const val EVENT_STOPPED = "onSpeechStopped"
    const val EVENT_ERROR = "onSpeechError"
  }
}
