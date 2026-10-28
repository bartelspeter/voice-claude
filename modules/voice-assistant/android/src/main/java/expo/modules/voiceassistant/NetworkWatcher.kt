package expo.modules.voiceassistant

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Tracks whether the phone has validated internet (a network that actually reaches the
 * outside world, not just a cell icon). Hosted by [ClaudeVoiceTapService] so it runs exactly
 * while walk mode is on; the JS side can also hold it open while it listens for changes.
 * All callbacks are delivered on the main thread.
 */
object NetworkWatcher {
  private const val TAG = "VoiceClaude"

  private val handler = Handler(Looper.getMainLooper())
  private val owners = mutableSetOf<String>()
  private val validated = mutableSetOf<Network>()
  // A set so re-registering the same listener (service instance churn) can't double it up.
  private val listeners = mutableSetOf<(Boolean) -> Unit>()
  private var manager: ConnectivityManager? = null
  private var callback: ConnectivityManager.NetworkCallback? = null

  @Volatile private var online = false
  @Volatile private var running = false

  /** True while the watcher is registered, so [isOnline] reflects live callbacks. */
  val isRunning: Boolean get() = running

  /**
   * Current state. Falls back to a one-off ConnectivityManager check when nobody is
   * hosting the watcher (walk mode off, JS not listening).
   */
  fun isOnline(context: Context): Boolean = if (running) online else check(context)

  fun check(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  }

  fun addListener(listener: (Boolean) -> Unit) = synchronized(listeners) { listeners.add(listener) }

  fun removeListener(listener: (Boolean) -> Unit) = synchronized(listeners) { listeners.remove(listener) }

  /** Registers the callback on first owner. Owners are names so a double start is harmless. */
  @Synchronized
  fun start(context: Context, owner: String) {
    owners.add(owner)
    if (running) return
    val app = context.applicationContext
    val cm = app.getSystemService(ConnectivityManager::class.java) ?: run {
      Log.w(TAG, "No connectivity manager; network watcher not started")
      return
    }
    val request = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
      .build()
    val cb = object : ConnectivityManager.NetworkCallback() {
      // A filtered callback only reports networks matching the request, so onLost also
      // fires when a network stays up but loses validation (the jungle case).
      override fun onAvailable(network: Network) {
        handler.post { if (validated.add(network)) update("available $network") }
      }

      override fun onLost(network: Network) {
        handler.post { if (validated.remove(network)) update("lost $network") }
      }
    }
    validated.clear()
    online = check(app)
    manager = cm
    callback = cb
    running = true
    cm.registerNetworkCallback(request, cb, handler)
    Log.i(TAG, "Network watcher started by $owner, online=$online")
  }

  @Synchronized
  fun stop(owner: String) {
    owners.remove(owner)
    if (owners.isNotEmpty() || !running) return
    callback?.let { cb -> runCatching { manager?.unregisterNetworkCallback(cb) } }
    callback = null
    manager = null
    running = false
    handler.post { validated.clear() }
    Log.i(TAG, "Network watcher stopped by $owner")
  }

  private fun update(reason: String) {
    val now = validated.isNotEmpty()
    if (now == online) return
    online = now
    Log.i(TAG, "Network ${if (now) "ONLINE" else "OFFLINE"} ($reason)")
    val snapshot = synchronized(listeners) { listeners.toList() }
    snapshot.forEach { listener -> runCatching { listener(now) }.onFailure { Log.w(TAG, "Network listener failed", it) } }
  }
}
