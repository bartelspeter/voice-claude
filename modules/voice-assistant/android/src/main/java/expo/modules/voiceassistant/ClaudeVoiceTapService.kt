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
 */
class ClaudeVoiceTapService : AccessibilityService() {
  private val handler = Handler(Looper.getMainLooper())
  private var newChatTapped = false
  private var backPresses = 0
  private var voiceTaps = 0
  private var labelsLogged = false
  private var lastTapAt = 0L

  override fun onServiceConnected() {
    instance = this
    Log.i(TAG, "Voice tap service connected")
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onInterrupt() = Unit

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (isArmed()) step()
  }

  private fun start() {
    newChatTapped = false
    backPresses = 0
    voiceTaps = 0
    labelsLogged = false
    lastTapAt = 0L
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
      disarm()
      if (lockAfterwards) {
        handler.postDelayed({
          Log.i(TAG, "Locking the screen")
          performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        }, LOCK_DELAY_MS)
      }
      return
    }

    if (!newChatTapped) {
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

    private fun labels(vararg patterns: String) = patterns.map { Regex(it, RegexOption.IGNORE_CASE) }

    // Labels seen in Claude for Android 1.261016.51.
    private val VOICE_ACTIVE_LABELS = labels("Mute microphone", "Unmute microphone")
    private val NEW_CHAT_LABELS = labels("New chat")
    private val VOICE_BUTTON_LABELS = labels("(Start )?voice mode", "Use voice mode", "Voice")

    @Volatile private var instance: ClaudeVoiceTapService? = null
    @Volatile private var armedUntil = 0L
    @Volatile var lockAfterwards = true

    private fun isArmed() = SystemClock.elapsedRealtime() < armedUntil

    private fun disarm() {
      armedUntil = 0L
    }

    /** Called right before the Claude app is opened by the earbud. */
    fun arm() {
      val service = instance ?: return
      armedUntil = SystemClock.elapsedRealtime() + ARM_MS
      service.handler.post { service.start() }
    }

    fun isEnabled(context: Context): Boolean {
      val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
      return enabled.split(':').any { it.endsWith(ClaudeVoiceTapService::class.java.name) }
    }
  }
}
