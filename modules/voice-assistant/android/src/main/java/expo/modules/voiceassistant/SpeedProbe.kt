package expo.modules.voiceassistant

import android.os.SystemClock
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

/**
 * Is the link good enough for a voice chat? A phone showing 3G with one bar often
 * "has internet" per Android but can't carry audio, so the resume logic asks this
 * before reopening the Claude app. Blocking; call from a background thread.
 */
object SpeedProbe {
  private const val TAG = "VoiceClaude"

  /*
   * Tuning for the jungle. Thresholds are deliberately low: a real-time voice chat needs
   * roughly 30-60 kbps each way plus headroom, and the point is only to avoid reopening
   * Claude on a link that will drop the session again a minute later.
   */
  /** Round trip to Cloudflare must be at most this. */
  const val MAX_LATENCY_MS = 1_000L
  /** Download must reach at least this many kbit/s. */
  const val MIN_DOWN_KBPS = 150.0
  /** Upload must reach at least this many kbit/s. */
  const val MIN_UP_KBPS = 50.0
  /** The whole three-step probe must finish within this. */
  const val TIMEOUT_MS = 8_000L
  /** How often to re-probe while the link is up but too slow. */
  const val RETRY_INTERVAL_MS = 30_000L
  /** Stop re-probing (and give up on a resume) this long after the link first came back. */
  const val GIVE_UP_AFTER_MS = 20 * 60_000L

  private const val DOWN_BYTES = 65_536
  private const val UP_BYTES = 16 * 1_024
  private const val BASE = "https://speed.cloudflare.com"

  data class Result(val ok: Boolean, val latencyMs: Long, val downKbps: Double, val upKbps: Double) {
    fun toMap(): Map<String, Any> = mapOf("ok" to ok, "latencyMs" to latencyMs, "downKbps" to downKbps, "upKbps" to upKbps)
  }

  /** Never throws: any failure or timeout is reported as ok=false with whatever was measured. */
  fun run(): Result {
    val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS
    var latency = -1L
    var down = 0.0
    var up = 0.0
    try {
      latency = timed { get("$BASE/__down?bytes=0", deadline) }.first
      val (downMs, downBytes) = timed { get("$BASE/__down?bytes=$DOWN_BYTES", deadline) }
      down = kbps(downBytes, downMs)
      val (upMs, _) = timed { post("$BASE/__up", deadline) }
      up = kbps(UP_BYTES, upMs)
    } catch (e: Exception) {
      Log.i(TAG, "Speed probe failed: ${e.javaClass.simpleName}: ${e.message}")
      return Result(false, latency, down, up).also { log(it) }
    }
    val ok = latency <= MAX_LATENCY_MS && down >= MIN_DOWN_KBPS && up >= MIN_UP_KBPS
    return Result(ok, latency, down, up).also { log(it) }
  }

  private fun log(r: Result) =
    Log.i(TAG, "Speed probe ${if (r.ok) "passed" else "FAILED"}: latency ${r.latencyMs} ms, down ${"%.0f".format(r.downKbps)} kbps, up ${"%.0f".format(r.upKbps)} kbps")

  private fun kbps(bytes: Int, ms: Long): Double = if (ms <= 0) 0.0 else bytes * 8.0 / ms

  private inline fun timed(block: () -> Int): Pair<Long, Int> {
    val start = SystemClock.elapsedRealtime()
    val bytes = block()
    return (SystemClock.elapsedRealtime() - start) to bytes
  }

  private fun open(url: String, deadline: Long): HttpURLConnection {
    val remaining = deadline - SystemClock.elapsedRealtime()
    if (remaining <= 0) throw IllegalStateException("probe timed out")
    return (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = remaining.toInt()
      readTimeout = remaining.toInt()
      useCaches = false
      setRequestProperty("Cache-Control", "no-cache")
    }
  }

  /** Reads the whole body; returns its size. */
  private fun get(url: String, deadline: Long): Int {
    val conn = open(url, deadline)
    try {
      if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode} from $url")
      val buffer = ByteArray(8_192)
      var total = 0
      conn.inputStream.use { input ->
        while (true) {
          if (SystemClock.elapsedRealtime() > deadline) throw IllegalStateException("probe timed out mid-download")
          val n = input.read(buffer)
          if (n < 0) break
          total += n
        }
      }
      return total
    } finally {
      conn.disconnect()
    }
  }

  private fun post(url: String, deadline: Long): Int {
    val conn = open(url, deadline)
    try {
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.setFixedLengthStreamingMode(UP_BYTES)
      conn.setRequestProperty("Content-Type", "application/octet-stream")
      conn.outputStream.use { it.write(ByteArray(UP_BYTES)) }
      if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode} from $url")
      conn.inputStream.use { it.readBytes() }
      return UP_BYTES
    } finally {
      conn.disconnect()
    }
  }
}
