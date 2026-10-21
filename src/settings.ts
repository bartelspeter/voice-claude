import * as SecureStore from 'expo-secure-store';

export type Settings = {
  anthropicKey: string;
  deepgramKey: string;
  useEarbudMic: boolean;
};

const KEYS = {
  anthropicKey: 'anthropic-api-key',
  deepgramKey: 'deepgram-api-key',
  useEarbudMic: 'use-earbud-mic',
} as const;

export async function loadSettings(): Promise<Settings> {
  const [anthropicKey, deepgramKey, useEarbudMic] = await Promise.all([
    SecureStore.getItemAsync(KEYS.anthropicKey),
    SecureStore.getItemAsync(KEYS.deepgramKey),
    SecureStore.getItemAsync(KEYS.useEarbudMic),
  ]);
  return {
    anthropicKey: anthropicKey ?? '',
    deepgramKey: deepgramKey ?? '',
    useEarbudMic: useEarbudMic !== 'false',
  };
}

export async function saveSettings(settings: Settings) {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.anthropicKey, settings.anthropicKey.trim()),
    SecureStore.setItemAsync(KEYS.deepgramKey, settings.deepgramKey.trim()),
    SecureStore.setItemAsync(KEYS.useEarbudMic, String(settings.useEarbudMic)),
  ]);
}
