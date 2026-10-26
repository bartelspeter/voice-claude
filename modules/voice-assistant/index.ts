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
  /** Lets the app appear over the lock screen and wake the screen. */
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
}

export default requireNativeModule<VoiceAssistantModule>('VoiceAssistant');
