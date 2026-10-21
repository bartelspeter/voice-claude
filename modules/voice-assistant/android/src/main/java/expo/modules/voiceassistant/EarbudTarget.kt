package expo.modules.voiceassistant

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

  /** Opens the Claude app if that's the target. Returns false to fall back to Voice Claude. */
  fun openClaudeAppIfTarget(context: Context, launch: (Intent) -> Unit): Boolean {
    if (get(context) != CLAUDE_APP) return false
    val intent = claudeAppIntent(context) ?: return false
    Log.i("VoiceClaude", "Handing earbud trigger to the Claude app")
    launch(intent)
    return true
  }
}
