package expo.modules.voiceassistant

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * After the earbud hands off to the Claude app, taps through to a new voice chat
 * so the phone can stay in a pocket. It only acts while armed by [arm], and only
 * inside the Claude app. Matching is by accessibility labels, so a Claude UI change
 * can break it; every step is logged under "VoiceClaude".
 *
 * While connected (walk mode on) it also hosts the [NetworkWatcher] and [SessionResume],
 * which bring a voice chat back after a signal drop without another foreground service.
 */
class ClaudeVoiceTapService : AccessibilityService() {
  private val handler = Handler(Looper.getMainLooper())
  private var newChatTapped = false
  private var backPresses = 0
  private var voiceTaps = 0
  private var reconnectTaps = 0
  private var reconnectCapLogged = false
  private var labelsLogged = false
  private var lastTapAt = 0L

  // Per-instance owner name: a new instance can connect before the old one's onDestroy,
  // so the old one must only release what it took itself.
  private val watcherOwner = "$WATCHER_OWNER@${System.identityHashCode(this)}"

  override fun onServiceConnected() {
    instance = this
    Log.i(TAG, "Voice tap service connected")
    NetworkWatcher.start(this, watcherOwner)
    SessionResume.attach(this)
  }

  override fun onDestroy() {
    // Always release this instance's share; SessionResume ignores a stale owner itself.
    if (instance === this) instance = null
    SessionResume.detach(this)
    NetworkWatcher.stop(watcherOwner)
    super.onDestroy()
  }

  override fun onInterrupt() = Unit

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Every Claude screen change is logged, armed or not, so new labels can be read off
    // `adb logcat -s VoiceClaude` by browsing the Claude app with walk mode on.
    if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) logScreen()
    if (isArmed()) step()
  }

  private var lastScreenLogged: List<String> = emptyList()

  private fun logScreen() {
    val root = rootInActiveWindow ?: return
    if (root.packageName != CLAUDE_PACKAGE) return
    val labels = labelsOnScreen(root)
    if (labels == lastScreenLogged) return
    lastScreenLogged = labels
    Log.i(TAG, "Claude screen: $labels")
  }

  private fun start() {
    newChatTapped = false
    backPresses = 0
    voiceTaps = 0
    reconnectTaps = 0
    reconnectCapLogged = false
    labelsLogged = false
    lastTapAt = 0L
    Log.i(TAG, "Tap flow armed${if (resumeMode) " in resume mode (no new session)" else ""}")
    poll()
  }

  /** Events don't always fire when Claude is already on screen, so poll while armed. */
  private fun poll() {
    if (!isArmed()) return
    step()
    handler.postDelayed(::poll, POLL_MS)
  }

  private fun step() {
    // Give the previous tap time to take effect before deciding again.
    if (SystemClock.elapsedRealtime() - lastTapAt < SETTLE_MS) return
    val root = rootInActiveWindow ?: return
    if (root.packageName != CLAUDE_PACKAGE) return
    if (!labelsLogged) {
      labelsLogged = true
      Log.i(TAG, "Claude labels on screen: ${labelsOnScreen(root)}")
    }

    // Visibility is ignored here: mid-animation the voice controls can report as hidden,
    // and pressing back then would end the voice chat.
    if (findByLabel(root, VOICE_ACTIVE_LABELS, visibleOnly = false) != null) {
      Log.i(TAG, "Voice mode is on")
      SessionResume.onVoiceModeOn()
      disarm()
      if (lockAfterwards) {
        handler.postDelayed({
          Log.i(TAG, "Locking the screen")
          performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        }, LOCK_DELAY_MS)
      }
      return
    }

    // Resume mode keeps the current chat: skip "New session" and clear any reconnect prompt
    // the dead voice session may have left behind. Tapped at most once: a "Retry" that stays
    // (a failed message, say) would otherwise be re-sent every settle interval and the voice
    // button never reached.
    if (resumeMode) {
      findByLabel(root, RECONNECT_LABELS)?.let {
        if (reconnectTaps < MAX_RECONNECT_TAPS) {
          reconnectTaps++
          Log.i(TAG, "Tapping reconnect prompt (${labelOf(it)})")
          tap(it)
          return
        }
        if (!reconnectCapLogged) {
          reconnectCapLogged = true
          Log.w(TAG, "Reconnect prompt (${labelOf(it)}) still on screen after $MAX_RECONNECT_TAPS tap; ignoring it and looking for the voice button")
        }
      }
    } else if (!newChatTapped) {
      findByLabel(root, NEW_CHAT_LABELS)?.let {
        Log.i(TAG, "Tapping new chat (${labelOf(it)})")
        newChatTapped = true
        tap(it)
        return
      }
    }

    findByLabel(root, VOICE_BUTTON_LABELS)?.let {
      if (voiceTaps >= MAX_VOICE_TAPS) {
        Log.w(TAG, "Voice button (${labelOf(it)}) doesn't respond, giving up. Labels on screen: ${labelsOnScreen(root)}")
        disarm()
        return
      }
      voiceTaps++
      // If a click action didn't start voice mode, a real tap on the screen usually does.
      Log.i(TAG, "Tapping voice mode (${labelOf(it)}), attempt $voiceTaps")
      tap(it, gesture = voiceTaps > 1)
      return
    }

    // Probably on a settings page or drawer: back out toward the chat screen.
    if (backPresses < MAX_BACK_PRESSES) {
      Log.i(TAG, "No voice button found, pressing back. Labels on screen: ${labelsOnScreen(root)}")
      backPresses++
      lastTapAt = SystemClock.elapsedRealtime()
      performGlobalAction(GLOBAL_ACTION_BACK)
    } else {
      Log.w(TAG, "Gave up looking for the voice button")
      disarm()
    }
  }

  private fun tap(node: AccessibilityNodeInfo, gesture: Boolean = false) {
    lastTapAt = SystemClock.elapsedRealtime()
    var target: AccessibilityNodeInfo? = node
    while (target != null && !target.isClickable) target = target.parent
    if (!gesture && target?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) return
    // Some Compose nodes ignore ACTION_CLICK; fall back to a real tap on the centre.
    val bounds = Rect().also(node::getBoundsInScreen)
    val path = Path().apply { moveTo(bounds.exactCenterX(), bounds.exactCenterY()) }
    dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, 50)).build(), null, null)
  }

  /** First node whose content description or text matches one of [labels] (case-insensitive, whole label). */
  private fun findByLabel(root: AccessibilityNodeInfo, labels: List<Regex>, visibleOnly: Boolean = true): AccessibilityNodeInfo? {
    val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
    while (queue.isNotEmpty()) {
      val node = queue.removeFirst()
      val label = labelOf(node)
      if (label != null && (node.isVisibleToUser || !visibleOnly) && labels.any { it.matches(label) }) return node
      for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
    }
    return null
  }

  private fun labelOf(node: AccessibilityNodeInfo) = (node.contentDescription ?: node.text)?.toString()?.trim()

  /** Every label on screen, for fixing the patterns below when Claude's UI changes. */
  private fun labelsOnScreen(root: AccessibilityNodeInfo): List<String> {
    val found = mutableListOf<String>()
    val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
    while (queue.isNotEmpty()) {
      val node = queue.removeFirst()
      node.contentDescription?.let { found.add(it.toString()) }
      for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
    }
    return found
  }

  companion object {
    private const val TAG = "VoiceClaude"
    private const val CLAUDE_PACKAGE = "com.anthropic.claude"
    private const val ARM_MS = 20_000L
    private const val POLL_MS = 400L
    private const val SETTLE_MS = 900L
    private const val LOCK_DELAY_MS = 1_500L
    private const val MAX_BACK_PRESSES = 4
    private const val MAX_VOICE_TAPS = 4
    private const val MAX_RECONNECT_TAPS = 1

    private fun labels(vararg patterns: String) = patterns.map { Regex(it, RegexOption.IGNORE_CASE) }

    // Labels seen in Claude for Android 1.261016.51.
    private val VOICE_ACTIVE_LABELS = labels("Mute microphone", "Unmute microphone")
    private val NEW_CHAT_LABELS = labels("New session", "New chat")
    private val VOICE_BUTTON_LABELS = labels("(Start )?voice mode", "Use voice mode", "Voice")
    // Guesses for whatever Claude shows after a voice session dies; harmless if never seen.
    private val RECONNECT_LABELS = labels("Retry", "Try again", "Reconnect", "Resume")

    private const val WATCHER_OWNER = "tap-service"

    @Volatile private var instance: ClaudeVoiceTapService? = null
    @Volatile private var armedUntil = 0L
    @Volatile private var resumeMode = false
    @Volatile var lockAfterwards = true

    private fun isArmed() = SystemClock.elapsedRealtime() < armedUntil

    private fun disarm() {
      armedUntil = 0L
    }

    /**
     * Called right before the Claude app is opened. [resume] keeps the chat already on
     * screen (after a signal drop, or text handed over as the opening message) and only
     * taps the voice button.
     */
    fun arm(resume: Boolean = false) {
      val service = instance ?: run {
        Log.w(TAG, "Voice tap service not running; Claude will open without the tap flow")
        return
      }
      resumeMode = resume
      armedUntil = SystemClock.elapsedRealtime() + ARM_MS
      service.handler.post { service.start() }
    }

    fun isEnabled(context: Context): Boolean {
      val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
      return enabled.split(':').any { it.endsWith(ClaudeVoiceTapService::class.java.name) }
    }
  }
}
