import { NativeModule, requireNativeModule } from 'expo';

/** 'voice-claude' runs the conversation here; 'claude-app' hands off to the official Claude app. */
export type EarbudTarget = 'voice-claude' | 'claude-app';

type VoiceAssistantEvents = {
  onAssistTrigger: () => void;
};

declare class VoiceAssistantModule extends NativeModule<VoiceAssistantEvents> {
  /** True if the app was opened by the assistant (earbud long press) since the last call. */
  consumePendingTrigger(): boolean;
  /** Which app an earbud long press opens. */
  getEarbudTarget(): EarbudTarget;
  setEarbudTarget(target: EarbudTarget): void;
  isClaudeAppInstalled(): boolean;
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
}

export default requireNativeModule<VoiceAssistantModule>('VoiceAssistant');
