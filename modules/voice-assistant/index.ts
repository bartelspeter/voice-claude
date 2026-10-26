import { NativeModule, requireNativeModule } from 'expo';

/** 'voice-claude' runs the conversation here; 'claude-app' hands off to the official Claude app. */
export type EarbudTarget = 'voice-claude' | 'claude-app';

/** Earbud cues played natively (no asset files): see `playTone`. */
export type ToneKind = 'back' | 'gaveUp' | 'pip' | 'note';

/** Result of the link quality check behind `probeNetwork`. */
export type NetworkProbe = {
  /** True when latency, download and upload all met the voice-chat thresholds. */
  ok: boolean;
  /** Round trip to Cloudflare in milliseconds; -1 if it never answered. */
  latencyMs: number;
  downKbps: number;
  upKbps: number;
};

type VoiceAssistantEvents = {
  onAssistTrigger: () => void;
  /**
   * Validated internet came or went. Sent on every transition while something listens
   * (walk mode on, or a JS subscriber), plus once with the current state on subscribe.
   */
  onNetworkChange: (payload: { online: boolean }) => void;
  /** A timer armed with `startTimer` ran out (never sent for a cancelled or re-armed id). */
  onTimer: (payload: { id: string }) => void;
  /** The engine began playing the utterance queued with `speak`. */
  onSpeechStart: (payload: { id: string }) => void;
  /** The utterance played to the end. Exactly one of done/stopped/error is sent per id. */
  onSpeechDone: (payload: { id: string }) => void;
  /** `stopSpeaking` interrupted the utterance, or discarded it before it started. */
  onSpeechStopped: (payload: { id: string }) => void;
  /** The engine could not speak the utterance, even after being recreated once. */
  onSpeechError: (payload: { id: string }) => void;
};

declare class VoiceAssistantModule extends NativeModule<VoiceAssistantEvents> {
  /** True if the app was opened by the assistant (earbud long press) since the last call. */
  consumePendingTrigger(): boolean;
  /** Which app an earbud long press opens. */
  getEarbudTarget(): EarbudTarget;
  setEarbudTarget(target: EarbudTarget): void;
  isClaudeAppInstalled(): boolean;
  /** Whether the accessibility service that taps Claude's voice button is switched on. */
  isVoiceTapEnabled(): boolean;
  openAccessibilitySettings(): void;
  /** True once WRITE_SECURE_SETTINGS has been granted over adb, so walk mode can flip the service itself. */
  canToggleWalkMode(): boolean;
  /** Whether the user accepted the accessibility disclosure; walk mode can't be turned on without it. */
  hasAccessibilityConsent(): boolean;
  setAccessibilityConsent(accepted: boolean): void;
  /** Turns the voice tap service on or off. Returns false (and opens accessibility settings) without the grant. */
  setWalkMode(on: boolean): boolean;
  /** Whether this app holds the Android default digital assistant role. */
  isDefaultAssistant(): boolean;
  /** Opens the system screen where the digital assistant app is chosen. */
  openAssistantSettings(): void;
  /** Lets the app appear over the lock screen (without waking or unlocking the phone). */
  setShowWhenLocked(show: boolean): void;
  startConversationService(): void;
  stopConversationService(): void;
  /** Routes recording to the Bluetooth headset mic. Returns false if no headset mic is available. */
  setBluetoothMic(enabled: boolean): boolean;
  /**
   * Hands text to the official Claude app as the opening message of a new chat (share intent,
   * clipboard fallback) and arms the voice tap. Returns false only if the app isn't installed.
   */
  sendToClaudeApp(text: string): boolean;
  /** Plays a short earbud cue; see `ToneKind`. */
  playTone(kind: ToneKind): void;
  /** Validated internet per the OS; see `probeNetwork` for whether the link is actually usable. */
  isOnline(): boolean;
  /** Measures the link against Cloudflare. Never rejects; `ok` is false when offline or too slow. */
  probeNetwork(): Promise<NetworkProbe>;
  /** Transient may-duck audio focus, held until `abandonAudioFocus`. */
  requestAudioFocus(): boolean;
  abandonAudioFocus(): void;
  /** True while walk mode is waiting for signal to reopen a Claude voice chat that a drop ended. */
  isResumePending(): boolean;
  /**
   * Arms a timer on the Android main looper that fires `onTimer` with `id` after `delayMs`.
   * Exists because React Native pauses every JS setTimeout/setInterval while the activity is
   * paused (JavaTimerManager.onHostPause), and this app's conversations run from the lock screen
   * with the activity behind the keyguard. Starting an id that is already armed restarts it.
   * Use the wrappers in src/timers.ts rather than calling this directly.
   */
  startTimer(id: string, delayMs: number): void;
  /** Disarms a timer from `startTimer`; a no-op for an unknown or already fired id. */
  cancelTimer(id: string): void;
  /**
   * Queues `text` for text-to-speech as utterance `id` (QUEUE_ADD, so calls play in order) and
   * reports back through the `onSpeech*` events. `language` is a BCP 47 tag such as "en-US"; a
   * language the engine lacks is still spoken in its default voice.
   *
   * TTS lives in this module instead of expo-speech because expo-speech shuts its engine down
   * when the activity is destroyed and never rebinds it. This app keeps talking from a foreground
   * service with the activity behind the keyguard or gone, and after that every expo-speech
   * `speak` failed with "not bound to TTS engine" and sent no done/error event, so src/tts.ts
   * waited forever. This engine is kept for the life of the module and recreated once if it
   * fails to bind, dies or rejects an utterance. Use `SentenceSpeaker` in src/tts.ts rather
   * than calling this directly.
   */
  speak(id: string, text: string, language: string): void;
  /** Stops the current utterance and drops queued ones; each affected id gets `onSpeechStopped`. */
  stopSpeaking(): void;
  /** True while an utterance is playing or waiting for the engine. */
  isSpeaking(): boolean;
}

export default requireNativeModule<VoiceAssistantModule>('VoiceAssistant');
