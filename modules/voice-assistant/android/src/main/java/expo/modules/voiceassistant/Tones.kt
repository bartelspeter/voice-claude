package expo.modules.voiceassistant

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Short earbud cues built from the system tone generator, so no asset files are needed.
 * Each cue briefly takes transient audio focus (ducking Spotify etc.) and gives it back.
 *
 * DTMF tones are used for the pitched sequences because they are the only ToneGenerator
 * tones with a predictable pitch order: 1 (697 Hz) < 4 (770 Hz) < 7 (852 Hz) < * (941 Hz).
 */
object Tones {
  private const val TAG = "VoiceClaude"
  private const val VOLUME = 90 // percent of the music stream volume
  private const val GAP_MS = 60L

  /** Network is back and fast enough; the chat is being resumed. Two short rising beeps. */
  const val BACK = "back"
  /** The resume wait timed out. Three descending beeps. */
  const val GAVE_UP = "gaveUp"
  /** The network is good again and a new session could be started. One short beep. */
  const val PIP = "pip"
  /** An offline note started or stopped. Short double beep. */
  const val NOTE = "note"

  private val handler = Handler(Looper.getMainLooper())

  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  /** Returns false for an unknown kind. Safe to call from any thread. */
  fun play(context: Context, kind: String): Boolean {
    val steps: List<Pair<Int, Int>> = when (kind) {
      BACK -> listOf(ToneGenerator.TONE_DTMF_4 to 120, ToneGenerator.TONE_DTMF_S to 160)
      GAVE_UP -> listOf(ToneGenerator.TONE_DTMF_S to 150, ToneGenerator.TONE_DTMF_4 to 150, ToneGenerator.TONE_DTMF_1 to 250)
      PIP -> listOf(ToneGenerator.TONE_DTMF_7 to 110)
      NOTE -> listOf(ToneGenerator.TONE_DTMF_7 to 90, ToneGenerator.TONE_DTMF_7 to 90)
      else -> {
        Log.w(TAG, "Unknown tone '$kind'")
        return false
      }
    }
    handler.post { playSteps(context.applicationContext, kind, steps) }
    return true
  }

  private fun playSteps(context: Context, kind: String, steps: List<Pair<Int, Int>>) {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val generator = try {
      ToneGenerator(AudioManager.STREAM_MUSIC, VOLUME)
    } catch (e: RuntimeException) {
      Log.w(TAG, "Tone generator unavailable", e)
      return
    }
    val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes)
      .build()
    val granted = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    Log.i(TAG, "Playing tone '$kind' (focus ${if (granted) "granted" else "denied"})")

    var at = 0L
    for ((tone, duration) in steps) {
      handler.postDelayed({ generator.startTone(tone, duration) }, at)
      at += duration + GAP_MS
    }
    // Leave a little tail so the focus hand-back doesn't clip the last beep.
    handler.postDelayed({
      generator.release()
      audio.abandonAudioFocusRequest(focus)
    }, at + 200)
  }
}

/**
 * Transient audio focus that JS holds for as long as it likes (e.g. while an offline note
 * is being recorded), so music ducks instead of talking over the user.
 */
object HeldAudioFocus {
  private const val TAG = "VoiceClaude"
  private var request: AudioFocusRequest? = null

  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()

  @Synchronized
  fun request(context: Context): Boolean {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    request?.let { audio.abandonAudioFocusRequest(it) }
    val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(attributes)
      .build()
    val granted = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    request = if (granted) focus else null
    Log.i(TAG, "Audio focus ${if (granted) "held" else "denied"}")
    return granted
  }

  @Synchronized
  fun abandon(context: Context) {
    val focus = request ?: return
    request = null
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audio.abandonAudioFocusRequest(focus)
    Log.i(TAG, "Audio focus released")
  }
}
