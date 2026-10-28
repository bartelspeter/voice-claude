import * as SecureStore from 'expo-secure-store';

import VoiceAssistant, { EarbudTarget } from '../modules/voice-assistant';

export type Settings = {
  anthropicKey: string;
  deepgramKey: string;
  /** Slack bot (xoxb-…) or user (xoxp-…) token for reading and answering threads by voice. */
  slackToken: string;
  useEarbudMic: boolean;
  /** Stored natively so the earbud trigger can read it before JS starts. */
  earbudTarget: EarbudTarget;
};

const KEYS = {
  anthropicKey: 'anthropic-api-key',
  deepgramKey: 'deepgram-api-key',
  slackToken: 'slack-token',
  useEarbudMic: 'use-earbud-mic',
} as const;

export async function loadSettings(): Promise<Settings> {
  const [anthropicKey, deepgramKey, slackToken, useEarbudMic] = await Promise.all([
    SecureStore.getItemAsync(KEYS.anthropicKey),
    SecureStore.getItemAsync(KEYS.deepgramKey),
    SecureStore.getItemAsync(KEYS.slackToken),
    SecureStore.getItemAsync(KEYS.useEarbudMic),
  ]);
  return {
    anthropicKey: anthropicKey ?? '',
    deepgramKey: deepgramKey ?? '',
    slackToken: slackToken ?? '',
    useEarbudMic: useEarbudMic !== 'false',
    earbudTarget: VoiceAssistant.getEarbudTarget(),
  };
}

export async function saveSettings(settings: Settings) {
  VoiceAssistant.setEarbudTarget(settings.earbudTarget);
  await Promise.all([
    SecureStore.setItemAsync(KEYS.anthropicKey, settings.anthropicKey.trim()),
    SecureStore.setItemAsync(KEYS.deepgramKey, settings.deepgramKey.trim()),
    SecureStore.setItemAsync(KEYS.slackToken, settings.slackToken.trim()),
    SecureStore.setItemAsync(KEYS.useEarbudMic, String(settings.useEarbudMic)),
  ]);
}
