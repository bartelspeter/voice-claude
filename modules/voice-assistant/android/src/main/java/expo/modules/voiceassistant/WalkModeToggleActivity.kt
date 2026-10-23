package expo.modules.voiceassistant

import android.app.Activity
import android.os.Bundle
import android.widget.Toast

/** Target of the app-icon shortcuts; flips walk mode without opening the app. */
class WalkModeToggleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val on = intent.getBooleanExtra(EXTRA_ON, !WalkMode.isOn(this))
    if (WalkMode.set(this, on)) {
      Toast.makeText(this, if (on) "Walk mode on" else "Walk mode off: banking apps should work", Toast.LENGTH_SHORT).show()
    }
    finish()
  }

  companion object {
    const val EXTRA_ON = "on"
  }
}
