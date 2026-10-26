package expo.modules.voiceassistant

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class VoiceAssistantModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val networkListener: (Boolean) -> Unit = { online -> sendEvent("onNetworkChange", mapOf("online" to online)) }

  // The speed probe blocks for up to 8 s; keep it off the module queue.
  private val probeExecutor = Executors.newSingleThreadExecutor { Thread(it, "VoiceClaude-js-probe") }

  // JS timers for session code. React Native's JavaTimerManager pauses every JS setTimeout while
  // the activity is paused (behind the keyguard, where conversations run), so the idle, silence
  // and retry timers in src/ are kept on the main looper instead and fire back into JS as events.
  private val timerHandler = Handler(Looper.getMainLooper())
  private val timers = HashMap<String, Runnable>()

  override fun definition() = ModuleDefinition {
    Name("VoiceAssistant")

    Events("onAssistTrigger", "onNetworkChange", "onTimer")

    OnCreate {
      AssistTrigger.listener = { sendEvent("onAssistTrigger", emptyMap<String, Any>()) }
      NetworkWatcher.addListener(networkListener)
      runCatching { WalkMode.publishShortcuts(context) }
    }

    OnDestroy {
      AssistTrigger.listener = null
      NetworkWatcher.removeListener(networkListener)
      NetworkWatcher.stop(WATCHER_OWNER)
      // A new module instance makes its own executor on every JS reload; don't leak this one's thread.
      probeExecutor.shutdown()
      cancelAllTimers()
    }

    // Arms (or re-arms) the timer `id`; it fires `onTimer` with that id after `delayMs`.
    Function("startTimer") { id: String, delayMs: Double ->
      startTimer(id, delayMs)
    }

    Function("cancelTimer") { id: String ->
      cancelTimer(id)
    }

    // Keep the watcher alive while JS listens (even with walk mode off) and report the current state once.
    OnStartObserving("onNetworkChange") {
      NetworkWatcher.start(context, WATCHER_OWNER)
      sendEvent("onNetworkChange", mapOf("online" to NetworkWatcher.isOnline(context)))
    }

    OnStopObserving("onNetworkChange") {
      NetworkWatcher.stop(WATCHER_OWNER)
    }

    // Validated internet right now (live watcher state, or a one-off check when it isn't running).
    Function("isOnline") {
      NetworkWatcher.isOnline(context)
    }

    // Is the link good enough for a voice chat? Resolves ok=false on failure, never rejects.
    AsyncFunction("probeNetwork") { promise: Promise ->
      probeExecutor.execute {
        val result = runCatching { SpeedProbe.run() }
          .getOrElse { SpeedProbe.Result(false, -1, 0.0, 0.0) }
        promise.resolve(result.toMap())
      }
    }

    // "back", "gaveUp", "pip" or "note".
    Function("playTone") { kind: String ->
      Tones.play(context, kind)
    }

    Function("requestAudioFocus") {
      HeldAudioFocus.request(context)
    }

    Function("abandonAudioFocus") {
      HeldAudioFocus.abandon(context)
    }

    // Opens a new Claude chat with this text as the opening message, then taps voice mode.
    Function("sendToClaudeApp") { text: String ->
      EarbudTarget.sendText(context, text)
    }

    // A voice chat died with the signal and will be reopened once the link is good again.
    Function("isResumePending") {
      SessionResume.isPending
    }

    // True if the app was opened by the assistant since the last call.
    Function("consumePendingTrigger") {
      AssistTrigger.consume()
    }

    // "voice-claude" (this app, API key) or "claude-app" (the official Claude app).
    Function("getEarbudTarget") {
      EarbudTarget.get(context)
    }

    Function("setEarbudTarget") { target: String ->
      EarbudTarget.set(context, target)
    }

    Function("isClaudeAppInstalled") {
      EarbudTarget.isClaudeAppInstalled(context)
    }

    // The accessibility service that taps Claude's voice button for a pocket-only start.
    Function("isVoiceTapEnabled") {
      ClaudeVoiceTapService.isEnabled(context)
    }

    // Walk mode switches the voice tap service on/off (banking apps block it while it's on).
    Function("canToggleWalkMode") {
      WalkMode.canToggle(context)
    }

    Function("hasAccessibilityConsent") {
      WalkMode.hasConsent(context)
    }

    Function("setAccessibilityConsent") { accepted: Boolean ->
      WalkMode.setConsent(context, accepted)
    }

    Function("setWalkMode") { on: Boolean ->
      WalkMode.set(context, on)
    }

    Function("openAccessibilitySettings") {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("isDefaultAssistant") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        context.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)
      } else {
        false
      }
    }

    Function("openAssistantSettings") {
      val intent = Intent(Settings.ACTION_VOICE_INPUT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("setShowWhenLocked") { show: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        activity.setShowWhenLocked(show)
        activity.setTurnScreenOn(show)
      }
    }

    Function("startConversationService") {
      context.startForegroundService(Intent(context, ConversationService::class.java))
    }

    Function("stopConversationService") {
      context.stopService(Intent(context, ConversationService::class.java))
    }

    // Routes the mic to the Bluetooth headset (earbud mics). Returns false if none is connected.
    Function("setBluetoothMic") { enabled: Boolean ->
      val am = audioManager
      if (!enabled) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        else @Suppress("DEPRECATION") am.stopBluetoothSco()
        am.mode = AudioManager.MODE_NORMAL
        return@Function true
      }
      am.mode = AudioManager.MODE_IN_COMMUNICATION
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val headset = am.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
        headset != null && am.setCommunicationDevice(headset)
      } else {
        @Suppress("DEPRECATION") am.startBluetoothSco()
        true
      }
    }
  }

  private fun startTimer(id: String, delayMs: Double) {
    val runnable = object : Runnable {
      override fun run() {
        // Only the runnable still registered under this id may fire; a re-armed or cancelled one is stale.
        val live = synchronized(timers) {
          if (timers[id] === this) {
            timers.remove(id)
            true
          } else {
            false
          }
        }
        if (live) sendEvent("onTimer", mapOf("id" to id))
      }
    }
    val previous = synchronized(timers) { timers.put(id, runnable) }
    if (previous != null) timerHandler.removeCallbacks(previous)
    timerHandler.postDelayed(runnable, delayMs.toLong().coerceAtLeast(0L))
  }

  private fun cancelTimer(id: String) {
    val runnable = synchronized(timers) { timers.remove(id) }
    if (runnable != null) timerHandler.removeCallbacks(runnable)
  }

  private fun cancelAllTimers() {
    val pending = synchronized(timers) {
      val all = timers.values.toList()
      timers.clear()
      all
    }
    for (runnable in pending) timerHandler.removeCallbacks(runnable)
  }

  private companion object {
    const val WATCHER_OWNER = "js"
  }
}
