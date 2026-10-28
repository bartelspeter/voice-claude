package expo.modules.voiceassistant

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.Executors

/**
 * Brings a Claude voice chat back after a signal drop on a long run.
 *
 * The tap service reports when voice mode is on (session started). If the network then
 * drops while that session is live, we wait for validated internet, probe the link every
 * [SpeedProbe.RETRY_INTERVAL_MS] until it is fast enough, play the "back" tone and reopen
 * the same chat in resume mode (voice button only, no "New session"). Without a live
 * session, a recovered link after an outage just gets a "pip" so the user knows a new
 * session could be started. Only active while [ClaudeVoiceTapService] is connected.
 *
 * Everything runs on the main thread except the probe itself; entry points that may be
 * called from elsewhere (the JS module queue, the assist trampoline) hop over via [onMain].
 */
object SessionResume {
  private const val TAG = "VoiceClaude"

  /** A session older than this is not resumed: the user has surely moved on. */
  const val MAX_SESSION_AGE_MS = 3 * 60 * 60_000L
  /** Let the "back" tone finish before the Claude app takes the audio output. */
  private const val RESUME_LAUNCH_DELAY_MS = 700L

  private val handler = Handler(Looper.getMainLooper())
  private val executor = Executors.newSingleThreadExecutor { Thread(it, "VoiceClaude-probe") }
  private val listener: (Boolean) -> Unit = { online -> if (online) onOnline() else onOffline() }

  private var context: Context? = null
  /** The service instance that attached last; a stale instance's detach is ignored. */
  private var owner: Any? = null
  @Volatile private var startedAt = 0L
  @Volatile private var pending = false
  private var outageSeen = false
  private var probing = false
  private var probeDeadline = 0L

  val isPending: Boolean get() = pending

  /** Called when the tap service connects (walk mode on). Idempotent across instance churn. */
  fun attach(service: Context) = onMain {
    context = service.applicationContext
    owner = service
    NetworkWatcher.addListener(listener)
    Log.i(TAG, "Session resume attached")
  }

  /**
   * Walk mode off: nothing can tap the Claude app any more, so forget the session. If a
   * newer service instance has attached since, [service] is stale and nothing is torn down.
   */
  fun detach(service: Context) = onMain {
    if (owner !== service) {
      Log.i(TAG, "Session resume detach from a stale service instance ignored")
      return@onMain
    }
    owner = null
    NetworkWatcher.removeListener(listener)
    stopProbing()
    pending = false
    startedAt = 0L
    probeDeadline = 0L
    context = null
    Log.i(TAG, "Session resume detached")
  }

  /** The tap flow saw Claude's voice controls: a (new or resumed) session is live from now. */
  fun onVoiceModeOn() = onMain {
    startedAt = SystemClock.elapsedRealtime()
    pending = false
    Log.i(TAG, "Voice session recorded as started")
  }

  /** The user is starting fresh (earbud press, text handed to Claude): drop any resume. */
  fun onNewChat(reason: String) = onMain {
    if (pending || probing) Log.i(TAG, "Pending resume cleared ($reason)")
    pending = false
    startedAt = 0L
    probeDeadline = 0L
    stopProbing()
  }

  /** Runs [block] now on the main thread, or posts it there when called from any other. */
  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() === Looper.getMainLooper()) block() else handler.post(block)
  }

  private fun onOffline() {
    outageSeen = true
    stopProbing()
    if (pending) {
      Log.i(TAG, "Offline again while a resume is pending; waiting for the link")
      return
    }
    val started = startedAt
    if (started == 0L) {
      Log.i(TAG, "Offline with no voice session to resume")
      return
    }
    val ageMin = (SystemClock.elapsedRealtime() - started) / 60_000
    if (SystemClock.elapsedRealtime() - started > MAX_SESSION_AGE_MS) {
      Log.i(TAG, "Offline; session is $ageMin min old, too old to resume")
      startedAt = 0L
      return
    }
    // Our own app doesn't record in claude-app mode, so any active recording is the Claude
    // app's voice mode. Since Android 10 other apps' recordings may be hidden from us, in
    // which case the list is empty and the age check alone decides.
    val recordings = runCatching {
      (context?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.activeRecordingConfigurations
    }.getOrNull()
    val rule = when {
      recordings == null -> "age only (recording API unavailable)"
      recordings.isEmpty() -> "age only (recording API reports nothing; other apps' recordings may be hidden)"
      else -> "age + recording (${recordings.size} active, sources ${recordings.map { it.clientAudioSource }})"
    }
    pending = true
    probeDeadline = 0L
    Log.i(TAG, "Offline; session is $ageMin min old, marked for resume by rule: $rule")
  }

  private fun onOnline() {
    when {
      pending -> startProbing("resume pending")
      outageSeen -> startProbing("outage seen, new session possible")
      else -> Log.i(TAG, "Online; nothing to do")
    }
  }

  private fun startProbing(reason: String) {
    if (probing) return
    probing = true
    if (probeDeadline == 0L) probeDeadline = SystemClock.elapsedRealtime() + SpeedProbe.GIVE_UP_AFTER_MS
    Log.i(TAG, "Probing the link ($reason), giving up in ${(probeDeadline - SystemClock.elapsedRealtime()) / 60_000} min")
    probeOnce()
  }

  private fun stopProbing() {
    probing = false
    handler.removeCallbacks(probeRunnable)
  }

  private val probeRunnable = Runnable { probeOnce() }

  private fun probeOnce() {
    if (!probing) return
    if (SystemClock.elapsedRealtime() > probeDeadline) {
      giveUp()
      return
    }
    executor.execute {
      val result = SpeedProbe.run()
      handler.post { onProbeResult(result) }
    }
  }

  private fun onProbeResult(result: SpeedProbe.Result) {
    if (!probing) return // cancelled while the probe ran
    if (!result.ok) {
      handler.postDelayed(probeRunnable, SpeedProbe.RETRY_INTERVAL_MS)
      return
    }
    probing = false
    probeDeadline = 0L
    val ctx = context ?: return
    if (pending) {
      resume(ctx)
    } else if (outageSeen) {
      outageSeen = false
      Log.i(TAG, "Link is good again after an outage; pip")
      Tones.play(ctx, Tones.PIP)
    }
  }

  private fun giveUp() {
    probing = false
    probeDeadline = 0L
    val ctx = context
    if (pending) {
      Log.w(TAG, "Link never got good enough; giving up on the resume")
      pending = false
      startedAt = 0L
      if (ctx != null) Tones.play(ctx, Tones.GAVE_UP)
    } else {
      Log.i(TAG, "Link never got good enough; no pip this time")
    }
  }

  /** Reopens the same chat through the trampoline, which handles the lock screen like an earbud press. */
  private fun resume(ctx: Context) {
    pending = false
    if (!EarbudTarget.isClaudeAppInstalled(ctx)) {
      Log.w(TAG, "Claude app not installed; cannot resume")
      return
    }
    Log.i(TAG, "Resuming the Claude voice chat")
    Tones.play(ctx, Tones.BACK)
    handler.postDelayed({
      val intent = Intent(ctx, AssistTrampolineActivity::class.java)
        .putExtra(AssistTrampolineActivity.EXTRA_RESUME, true)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      runCatching { ctx.startActivity(intent) }
        .onFailure { Log.e(TAG, "Could not open the trampoline for a resume", it) }
    }, RESUME_LAUNCH_DELAY_MS)
  }
}
