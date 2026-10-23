package expo.modules.voiceassistant

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: one tap turns walk mode (the voice tap service) on or off. */
class WalkModeTileService : TileService() {
  override fun onStartListening() = refresh()

  override fun onClick() {
    if (!WalkMode.isOn(this) && !WalkMode.hasConsent(this)) {
      packageManager.getLaunchIntentForPackage(packageName)?.let { collapseAndStart(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
      return
    }
    if (!WalkMode.canToggle(this)) {
      openAccessibilitySettings()
      return
    }
    WalkMode.set(this, !WalkMode.isOn(this))
    refresh()
  }

  // Tiles must collapse the shade to open an activity.
  private fun openAccessibilitySettings() =
    collapseAndStart(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

  @Suppress("DEPRECATION")
  private fun collapseAndStart(intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
    } else {
      startActivityAndCollapse(intent)
    }
  }

  private fun refresh() {
    val tile = qsTile ?: return
    tile.state = if (WalkMode.isOn(this)) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    tile.updateTile()
  }
}
