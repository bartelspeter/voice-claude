package expo.modules.voiceassistant

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Which app an earbud long press opens. Stored natively because the trampoline
 * runs before JS is up (or without it at all when handing off to the Claude app).
 */
object EarbudTarget {
  const val VOICE_CLAUDE = "voice-claude"
  const val CLAUDE_APP = "claude-app"

  private const val TAG = "VoiceClaude"
  private const val PREFS = "voice-assistant"
  private const val KEY = "earbud-target"
  private const val CLAUDE_PACKAGE = "com.anthropic.claude"

  fun get(context: Context): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, VOICE_CLAUDE) ?: VOICE_CLAUDE

  fun set(context: Context, target: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, target).apply()
  }

  fun isClaudeAppInstalled(context: Context): Boolean =
    context.packageManager.getLaunchIntentForPackage(CLAUDE_PACKAGE) != null

  /** The official Claude app's launch intent, or null if it isn't installed. */
  fun claudeAppIntent(context: Context): Intent? =
    context.packageManager.getLaunchIntentForPackage(CLAUDE_PACKAGE)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

  /**
   * Opens the Claude app if that's the target. Returns false to fall back to Voice Claude,
   * including when there is no validated internet: Claude can't talk then, so the press
   * goes to our own JS, which records an offline note instead.
   */
  fun openClaudeAppIfTarget(context: Context, launch: (Intent) -> Unit): Boolean {
    if (get(context) != CLAUDE_APP) return false
    val intent = claudeAppIntent(context) ?: return false
    if (!NetworkWatcher.isOnline(context)) {
      Log.i(TAG, "Offline; earbud trigger falls through to Voice Claude for an offline note")
      return false
    }
    Log.i(TAG, "Handing earbud trigger to the Claude app")
    ClaudeVoiceTapService.arm()
    launch(intent)
    return true
  }

  /** Reopens the chat already in the Claude app and only taps the voice button. */
  fun openClaudeAppForResume(context: Context, launch: (Intent) -> Unit): Boolean {
    val intent = claudeAppIntent(context) ?: return false
    Log.i(TAG, "Reopening the Claude app to resume the voice chat")
    ClaudeVoiceTapService.arm(resume = true)
    launch(intent)
    return true
  }

  /**
   * Hands [text] to the Claude app as the opening message of a new chat (an offline note,
   * once the link is back). Prefers a share intent; if Claude doesn't accept one, the text
   * goes to the clipboard and the app is simply opened. Returns false if Claude isn't installed
   * or couldn't be opened (background activity start limits), so the caller keeps the text.
   */
  fun sendText(context: Context, text: String): Boolean {
    val launchIntent = claudeAppIntent(context) ?: return false
    SessionResume.onNewChat("text handed to Claude")
    val share = Intent(Intent.ACTION_SEND)
      .setType("text/plain")
      .setPackage(CLAUDE_PACKAGE)
      .putExtra(Intent.EXTRA_TEXT, text)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val intent = if (context.packageManager.resolveActivity(share, 0) != null) {
      Log.i(TAG, "Sending ${text.length} chars to the Claude app via ACTION_SEND")
      share
    } else {
      Log.i(TAG, "Claude app has no share target; copying ${text.length} chars to the clipboard and opening it")
      val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText("Voice Claude note", text))
      launchIntent
    }
    // The share screen is already a fresh chat, so only the voice button is tapped.
    ClaudeVoiceTapService.arm(resume = true)
    return runCatching { context.startActivity(intent) }
      .onFailure { Log.e(TAG, "Could not open the Claude app to hand over the text", it) }
      .isSuccess
  }
}
