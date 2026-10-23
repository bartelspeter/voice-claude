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
      setEditing(loaded.earbudTarget === 'voice-claude' && (!loaded.anthropicKey || !loaded.deepgramKey));
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

  // The earbud reaches the app through Bluetooth VOICE_COMMAND, so the digital assistant role doesn't matter.
  if (settings.earbudTarget === 'claude-app') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <Text style={styles.status}>Ready</Text>
        <Text style={styles.partial}>Long-press your earbud to start Claude voice mode.</Text>
        <VoiceTapStatus />
        <View style={styles.transcript} />
        <Pressable onPress={() => setEditing(true)}>
          <Text style={styles.link}>Settings</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
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
  const claudeAppInstalled = VoiceAssistant.isClaudeAppInstalled();
  const usesClaudeApp = draft.earbudTarget === 'claude-app';
  const canSave = usesClaudeApp || (!!draft.anthropicKey.trim() && !!draft.deepgramKey.trim());
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.status}>Settings</Text>
      {claudeAppInstalled && (
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Earbud opens the Claude app</Text>
            <Text style={styles.hint}>Uses your Claude subscription and chat history. API keys are only needed for Voice Claude's own conversations.</Text>
          </View>
          <Switch
            value={usesClaudeApp}
            onValueChange={(on) => setDraft({ ...draft, earbudTarget: on ? 'claude-app' : 'voice-claude' })}
          />
        </View>
      )}
      {usesClaudeApp ? <VoiceTapStatus /> : <ApiKeyFields draft={draft} setDraft={setDraft} />}
      <View style={{ flex: 1 }} />
      <Pressable style={[styles.button, styles.talk, !canSave && { opacity: 0.4 }]} disabled={!canSave} onPress={() => onSave(draft)}>
        <Text style={styles.buttonText}>Save</Text>
      </Pressable>
    </View>
  );
}

/** Settings that only Voice Claude's own API-key conversations use. */
function ApiKeyFields({ draft, setDraft }: { draft: Settings; setDraft(settings: Settings): void }) {
  return (
    <>
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
    </>
  );
}

/**
 * Walk mode = the accessibility service that starts voice mode is on. Banking apps such as
 * KBank refuse to run while it is, so it can be switched off here, from the Quick Settings
 * tile, or from the app icon's long-press shortcuts.
 */
function VoiceTapStatus() {
  const [enabled, setEnabled] = useState(VoiceAssistant.isVoiceTapEnabled());
  const [canToggle, setCanToggle] = useState(VoiceAssistant.canToggleWalkMode());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      setEnabled(VoiceAssistant.isVoiceTapEnabled());
      setCanToggle(VoiceAssistant.canToggleWalkMode());
    });
    return () => sub.remove();
  }, []);

  const turnOn = () => {
    // Recorded natively so the Quick Settings tile and icon shortcuts honour it too.
    VoiceAssistant.setAccessibilityConsent(true);
    if (canToggle) {
      VoiceAssistant.setWalkMode(true);
      setEnabled(VoiceAssistant.isVoiceTapEnabled());
    } else {
      VoiceAssistant.openAccessibilitySettings();
    }
  };

  if (!enabled) return <AccessibilityDisclosure onAgree={turnOn} canToggle={canToggle} />;

  if (canToggle) {
    return (
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Walk mode</Text>
          <Text style={styles.hint}>
            On: the earbud starts Claude voice mode and locks the screen again. Turn off before using banking apps. Also in
            Quick Settings and on the app icon.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={() => {
            VoiceAssistant.setWalkMode(false);
            setEnabled(VoiceAssistant.isVoiceTapEnabled());
          }}
        />
      </View>
    );
  }
  return <Text style={styles.hint}>Voice mode starts automatically, then the screen locks again.</Text>;
}

/**
 * Prominent disclosure for the AccessibilityServices API (Google Play policy). Shown before the
 * user is sent to Accessibility settings, or before Walk mode is switched on.
 */
function AccessibilityDisclosure({ onAgree, canToggle }: { onAgree: () => void; canToggle: boolean }) {
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTitle}>Voice Claude uses the Accessibility service</Text>
      <Text style={styles.bannerText}>
        When you press the voice button on your Bluetooth headset, Voice Claude opens the Claude app and taps "New session"
        and "Voice Mode" for you, so a voice chat starts without touching the phone. The screen locks again afterwards.
      </Text>
      <Text style={styles.bannerText}>
        The service only acts inside the Claude app, and only for 20 seconds after a headset press. It does not read,
        collect or share any screen content or personal data.
      </Text>
      <Text style={styles.bannerText}>
        {canToggle
          ? 'Walk mode is off, so banking apps work. Turn it on before a walk.'
          : 'After you agree, Android Settings opens. Enable "Voice Claude earbud tap" under Installed apps.'}
      </Text>
      <Pressable style={styles.agreeButton} onPress={onAgree}>
        <Text style={styles.agreeText}>{canToggle ? 'Agree and turn on Walk mode' : 'Agree and open settings'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#141413', paddingHorizontal: 20, paddingTop: 64, paddingBottom: 32, gap: 12 },
  banner: { backgroundColor: '#3a2a12', borderRadius: 12, padding: 14, gap: 8 },
  bannerTitle: { color: '#faf9f5', fontSize: 16, fontWeight: '600' },
  bannerText: { color: '#f5d9a8', fontSize: 14 },
  agreeButton: { backgroundColor: '#d97757', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  agreeText: { color: '#faf9f5', fontSize: 15, fontWeight: '600' },
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
  hint: { color: '#b0aea5', fontSize: 13, paddingTop: 2, paddingRight: 12 },
  input: { backgroundColor: '#30302e', color: '#faf9f5', borderRadius: 10, padding: 12, fontSize: 16 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
});
