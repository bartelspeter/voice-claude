import { StatusBar } from 'expo-status-bar';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import VoiceAssistant from './modules/voice-assistant';
import { ClaudeChat } from './src/claude';
import { Conversation, ConversationState, Turn } from './src/conversation';
import { loadSettings, saveSettings, Settings } from './src/settings';
import { DeepgramListener } from './src/stt';
import { SentenceSpeaker } from './src/tts';

const STATE_LABELS: Record<ConversationState, string> = {
  idle: 'Long-press your earbud or tap Talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};

/** Resolves once the app is in the foreground (needed before starting the mic service). */
function waitForActive(timeoutMs = 3000): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    const sub = AppState.addEventListener('change', (next) => next === 'active' && finish());
    function finish() {
      clearTimeout(timer);
      sub.remove();
      resolve();
    }
  });
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<ConversationState>('idle');
  const [partial, setPartial] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState('');
  const [isDefaultAssistant, setIsDefaultAssistant] = useState(true);

  const conversation = useRef<Conversation | null>(null);
  const { stream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buffer) => conversation.current?.onAudio(buffer.data),
  });

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      setEditing(!loaded.anthropicKey || !loaded.deepgramKey);
    });
    requestRecordingPermissionsAsync();
    setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true });
  }, []);

  // Rebuild the conversation whenever the keys or mic setting change.
  useEffect(() => {
    if (!settings?.anthropicKey || !settings.deepgramKey) return;
    const created = new Conversation({
      mic: {
        start: async () => {
          await stream.start();
          return stream.sampleRate;
        },
        stop: () => stream.isStreaming && stream.stop(),
      },
      claude: new ClaudeChat(settings.anthropicKey),
      stt: new DeepgramListener(settings.deepgramKey),
      speaker: new SentenceSpeaker(),
      useEarbudMic: settings.useEarbudMic,
      onState: setState,
      onPartial: setPartial,
      onTurn: (turn) => setTurns((previous) => [...previous, turn]),
      onError: setError,
    });
    conversation.current = created;
    return () => {
      created.end(false);
      conversation.current = null;
    };
  }, [settings, stream]);

  const trigger = useCallback(async () => {
    await waitForActive();
    setError('');
    if (conversation.current?.state === 'idle') setTurns([]);
    conversation.current?.trigger();
  }, []);

  // Earbud long press: the native assistant session fires this event (or leaves a pending flag on cold start).
  useEffect(() => {
    if (!conversation.current) return;
    if (VoiceAssistant.consumePendingTrigger()) void trigger();
    const sub = VoiceAssistant.addListener('onAssistTrigger', () => {
      VoiceAssistant.consumePendingTrigger();
      void trigger();
    });
    return () => sub.remove();
  }, [settings, trigger]);

  useEffect(() => {
    const check = () => setIsDefaultAssistant(VoiceAssistant.isDefaultAssistant());
    check();
    const sub = AppState.addEventListener('change', (next) => next === 'active' && check());
    return () => sub.remove();
  }, []);

  if (!settings) return null;

  if (editing) {
    return (
      <SettingsScreen
        initial={settings}
        onSave={async (next) => {
          await saveSettings(next);
          setSettings(next);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      {!isDefaultAssistant && (
        <Pressable style={styles.banner} onPress={() => VoiceAssistant.openAssistantSettings()}>
          <Text style={styles.bannerText}>
            Set Voice Claude as your digital assistant app so the earbud long press opens it. Tap to open settings.
          </Text>
        </Pressable>
      )}
      <Text style={styles.status}>{STATE_LABELS[state]}</Text>
      {!!partial && state === 'listening' && <Text style={styles.partial}>{partial}</Text>}
      {!!error && <Text style={styles.error}>{error}</Text>}
      <ScrollView style={styles.transcript} contentContainerStyle={{ gap: 12 }}>
        {turns.map((turn, index) => (
          <Text key={index} style={turn.role === 'user' ? styles.user : styles.assistant}>
            {turn.text}
          </Text>
        ))}
      </ScrollView>
      <View style={styles.row}>
        <Pressable style={[styles.button, styles.talk]} onPress={trigger}>
          <Text style={styles.buttonText}>{state === 'idle' ? 'Talk' : state === 'listening' ? 'New chat' : 'Interrupt'}</Text>
        </Pressable>
        {state !== 'idle' && (
          <Pressable style={styles.button} onPress={() => conversation.current?.end()}>
            <Text style={styles.buttonText}>End</Text>
          </Pressable>
        )}
      </View>
      <Pressable onPress={() => setEditing(true)}>
        <Text style={styles.link}>Settings</Text>
      </Pressable>
    </View>
  );
}

function SettingsScreen({ initial, onSave }: { initial: Settings; onSave(settings: Settings): void }) {
  const [draft, setDraft] = useState(initial);
  const canSave = !!draft.anthropicKey.trim() && !!draft.deepgramKey.trim();
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.status}>Settings</Text>
      <Text style={styles.label}>Anthropic API key</Text>
      <TextInput
        style={styles.input}
        value={draft.anthropicKey}
        onChangeText={(anthropicKey) => setDraft({ ...draft, anthropicKey })}
        secureTextEntry
        autoCapitalize="none"
        placeholder="sk-ant-…"
        placeholderTextColor="#666"
      />
      <Text style={styles.label}>Deepgram API key</Text>
      <TextInput
        style={styles.input}
        value={draft.deepgramKey}
        onChangeText={(deepgramKey) => setDraft({ ...draft, deepgramKey })}
        secureTextEntry
        autoCapitalize="none"
        placeholderTextColor="#666"
      />
      <View style={styles.switchRow}>
        <Text style={styles.label}>Use earbud microphone</Text>
        <Switch value={draft.useEarbudMic} onValueChange={(useEarbudMic) => setDraft({ ...draft, useEarbudMic })} />
      </View>
      <Pressable style={[styles.button, styles.talk, !canSave && { opacity: 0.4 }]} disabled={!canSave} onPress={() => onSave(draft)}>
        <Text style={styles.buttonText}>Save</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#141413', paddingHorizontal: 20, paddingTop: 64, paddingBottom: 32, gap: 12 },
  banner: { backgroundColor: '#3a2a12', borderRadius: 12, padding: 12 },
  bannerText: { color: '#f5d9a8', fontSize: 14 },
  status: { color: '#faf9f5', fontSize: 28, fontWeight: '600' },
  partial: { color: '#b0aea5', fontSize: 18, fontStyle: 'italic' },
  error: { color: '#ff8a7a', fontSize: 14 },
  transcript: { flex: 1 },
  user: { color: '#b0aea5', fontSize: 16, alignSelf: 'flex-end', textAlign: 'right' },
  assistant: { color: '#faf9f5', fontSize: 17 },
  row: { flexDirection: 'row', gap: 12 },
  button: { flex: 1, backgroundColor: '#30302e', borderRadius: 16, paddingVertical: 20, alignItems: 'center' },
  talk: { backgroundColor: '#d97757', flex: 2 },
  buttonText: { color: '#faf9f5', fontSize: 20, fontWeight: '600' },
  link: { color: '#b0aea5', textAlign: 'center', paddingTop: 8 },
  label: { color: '#faf9f5', fontSize: 16 },
  input: { backgroundColor: '#30302e', color: '#faf9f5', borderRadius: 10, padding: 12, fontSize: 16 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
});
