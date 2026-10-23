package expo.modules.voiceassistant

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.provider.Settings
import android.util.Log

/**
 * Walk mode = the voice tap accessibility service is on. Banking apps such as KBank
 * refuse to run while a sideloaded accessibility service is enabled, so this lets
 * Peter switch it off before banking and back on before a walk.
 *
 * Flipping another app's accessibility setting needs WRITE_SECURE_SETTINGS, which
 * Android only grants over adb, once:
 *   adb shell pm grant com.bartelspeter.voiceclaude android.permission.WRITE_SECURE_SETTINGS
 * Without it, [set] opens the accessibility settings screen instead.
 */
object WalkMode {
  private const val TAG = "VoiceClaude"

  private const val PREFS = "voice-assistant"
  private const val CONSENT_KEY = "accessibility-consent"

  fun isOn(context: Context): Boolean = ClaudeVoiceTapService.isEnabled(context)

  /** Whether the user accepted the in-app accessibility disclosure (required by Play before enabling). */
  fun hasConsent(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(CONSENT_KEY, false)

  fun setConsent(context: Context, accepted: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(CONSENT_KEY, accepted).apply()
  }

  /** Opens Voice Claude so the disclosure can be shown before walk mode is turned on. */
  fun openAppForConsent(context: Context) {
    context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ?.let(context::startActivity)
  }

  fun canToggle(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

  /** Returns false (and opens the accessibility settings) if the app can't flip it itself. */
  fun set(context: Context, on: Boolean): Boolean {
    if (on && !hasConsent(context)) {
      openAppForConsent(context)
      return false
    }
    if (!canToggle(context)) {
      context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      return false
    }
    val resolver = context.contentResolver
    val service = ComponentName(context, ClaudeVoiceTapService::class.java).flattenToString()
    val others = (Settings.Secure.getString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: "")
      .split(':')
      .filter { it.isNotBlank() && !it.endsWith(ClaudeVoiceTapService::class.java.name) }
    val enabled = if (on) others + service else others
    Settings.Secure.putString(resolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, enabled.joinToString(":"))
    if (on) Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
    Log.i(TAG, "Walk mode ${if (on) "on" else "off"}")
    return true
  }

  /** Long-press shortcuts on the app icon: "Walk mode on" / "Walk mode off". */
  fun publishShortcuts(context: Context) {
    val manager = context.getSystemService(ShortcutManager::class.java) ?: return
    fun shortcut(on: Boolean) = ShortcutInfo.Builder(context, if (on) "walk-on" else "walk-off")
      .setShortLabel(if (on) "Walk mode on" else "Walk mode off")
      .setLongLabel(if (on) "Turn walk mode on" else "Turn walk mode off (for banking apps)")
      .setIcon(Icon.createWithResource(context, if (on) android.R.drawable.ic_btn_speak_now else android.R.drawable.ic_lock_lock))
      .setIntent(
        Intent(context, WalkModeToggleActivity::class.java)
          .setAction(Intent.ACTION_VIEW)
          .putExtra(WalkModeToggleActivity.EXTRA_ON, on)
      )
      .build()
    manager.setDynamicShortcuts(listOf(shortcut(true), shortcut(false)))
  }
}
