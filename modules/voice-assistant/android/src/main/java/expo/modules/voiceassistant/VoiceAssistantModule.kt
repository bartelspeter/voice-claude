package expo.modules.voiceassistant

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VoiceAssistantModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("VoiceAssistant")

    Events("onAssistTrigger")

    OnCreate {
      AssistTrigger.listener = { sendEvent("onAssistTrigger", emptyMap<String, Any>()) }
    }

    OnDestroy {
      AssistTrigger.listener = null
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
}
