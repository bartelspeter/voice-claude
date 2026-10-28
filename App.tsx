import { StatusBar } from 'expo-status-bar';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import * as Linking from 'expo-linking';
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
import { LightReply } from './src/light-mode';
import { NetworkMonitor } from './src/network';
import { NoteStatus, NoteTaker, noteStatusLine } from './src/notes';
import { loadSettings, saveSettings, Settings } from './src/settings';
import { parseThreadUrl, SlackClient, ThreadRef } from './src/slack';
import { DeepgramListener } from './src/stt';
import { SentenceSpeaker } from './src/tts';

const STATE_LABELS: Record<ConversationState, string> = {
  idle: 'Long-press your earbud or tap Talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  offline: 'No signal, waiting…',
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
  const [noteStatus, setNoteStatus] = useState<NoteStatus>({ recording: false, transcribing: false, queued: 0, ready: false });

  const conversation = useRef<Conversation | null>(null);
  const noteTaker = useRef<NoteTaker | null>(null);
  const [network] = useState(() => new NetworkMonitor());
  const lightReply = useRef<LightReply | null>(null);
  const { stream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    // Audio goes to whichever listener is active: a Slack light reply, otherwise the conversation.
    onBuffer: (buffer) => (lightReply.current?.active ? lightReply.current : conversation.current)?.onAudio(buffer.data),
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
      network,
      useEarbudMic: settings.useEarbudMic,
      // A note owns the mic; the NoteTaker's onStatus nudges retryResume() once it stops.
      canResume: () => !noteTaker.current?.busy,
      onState: setState,
      onPartial: setPartial,
      onTurn: (turn) => setTurns((previous) => [...previous, turn]),
      onError: setError,
    });
    conversation.current = created;
    return () => {
      created.dispose();
      conversation.current = null;
    };
  }, [settings, stream, network]);

  // Offline notes need only the Deepgram key, so they also work in claude-app mode.
  useEffect(() => {
    if (!settings?.deepgramKey) return;
    const target = settings.earbudTarget;
    const created = new NoteTaker({
      deepgramKey: settings.deepgramKey,
      network,
      useEarbudMic: settings.useEarbudMic,
      beforeRecord: () => stream.isStreaming && stream.stop(),
      // False (or a throw) keeps the note files for a later try.
      deliver: (text) => {
        if (target === 'claude-app') {
          try {
            return VoiceAssistant.sendToClaudeApp(text);
          } catch {
            return false; // startActivity refused, e.g. from the background
          }
        }
        if (!conversation.current) return false;
        setTurns([]);
        conversation.current.startWith(text);
        return true;
      },
      onStatus: (status) => {
        setNoteStatus(status);
        if (!status.recording) conversation.current?.retryResume();
      },
      onError: setError,
    });
    noteTaker.current = created;
    return () => {
      created.dispose();
      noteTaker.current = null;
    };
  }, [settings, stream, network]);

  const trigger = useCallback(async () => {
    try {
      await waitForActive();
      setError('');
      // An earbud press outranks a Slack reply in progress; the thread stays dropped, not re-queued.
      lightReply.current?.cancel();
      // Without signal the press records a note instead of starting a chat that cannot connect.
      const notes = noteTaker.current;
      if (notes && (notes.isRecording || conversation.current?.state === 'offline' || !network.isOnline())) {
        conversation.current?.goOffline('No signal');
        return await notes.toggle();
      }
      if (conversation.current?.state === 'idle') setTurns([]);
      conversation.current?.trigger();
    } catch (error) {
      setError(`Trigger failed: ${String(error)}`);
    }
  }, [network]);

  // Slack light-voice mode: voiceclaude://thread/<channel>/<ts> links (from the agents' Slack messages) queue up
  // and are read out one at a time, only while nothing else is using the microphone.
  const threadQueue = useRef<ThreadRef[]>([]);
  const [queued, setQueued] = useState(0);
  const [lightStatus, setLightStatus] = useState('');
  // The LightReply ref is set before start() runs and cleared in onDone, so it (not `.active`) says a reply is underway.
  const isBusy = () =>
    lightReply.current !== null ||
    !!noteTaker.current?.busy ||
    !network.isOnline() ||
    (conversation.current?.state ?? 'idle') !== 'idle';

  const drainThreads = useCallback(() => {
    if (!settings || isBusy()) return;
    const next = threadQueue.current.shift();
    setQueued(threadQueue.current.length);
    if (!next) return;
    if (!settings.slackToken || !settings.deepgramKey) {
      setError('Slack replies need a Slack token and a Deepgram key in Settings.');
      return;
    }
    setError('');
    const reply = new LightReply({
      mic: {
        start: async () => {
          await stream.start();
          return stream.sampleRate;
        },
        stop: () => stream.isStreaming && stream.stop(),
      },
      stt: new DeepgramListener(settings.deepgramKey),
      speaker: new SentenceSpeaker(),
      slack: new SlackClient(settings.slackToken),
      useEarbudMic: settings.useEarbudMic,
      earbudTarget: settings.earbudTarget,
      onState: (_, detail) => setLightStatus(detail),
      onError: setError,
      onEscalate: (transcript) => {
        setTurns([]);
        conversation.current?.startWith(transcript);
      },
      onDone: (outcome) => {
        lightReply.current = null;
        setLightStatus('');
        if (outcome === 'network') {
          // No signal: keep the thread at the front of the queue for the next online transition.
          threadQueue.current.unshift(next);
          setQueued(threadQueue.current.length);
          return;
        }
        setTimeout(drainThreads, 0);
      },
    });
    lightReply.current = reply;
    void waitForActive().then(() => reply.start(next));
  }, [settings, stream]);

  const initialUrlHandled = useRef(false);
  useEffect(() => {
    const enqueue = (url: string | null) => {
      const ref = url ? parseThreadUrl(url) : null;
      if (!ref) return;
      threadQueue.current.push(ref);
      setQueued(threadQueue.current.length);
      if (isBusy()) VoiceAssistant.playTone('pip');
      else drainThreads();
    };
    if (!initialUrlHandled.current) {
      initialUrlHandled.current = true;
      Linking.getInitialURL().then(enqueue, (error) => setError(`Could not read the launch link: ${String(error)}`));
    }
    const sub = Linking.addEventListener('url', ({ url }) => enqueue(url));
    return () => sub.remove();
  }, [drainThreads]);

  // Drain once settings are loaded, whenever the conversation returns to idle, and when a note stops.
  useEffect(() => {
    if (state === 'idle' && !noteStatus.recording) drainThreads();
  }, [state, noteStatus.recording, drainThreads]);

  // Threads held back while offline (isBusy) or re-queued after a failed fetch wait for signal.
  useEffect(() => network.onChange((online) => online && drainThreads()), [network, drainThreads]);

  // Earbud long press: the native assistant session fires this event (or leaves a pending flag on cold start).
  useEffect(() => {
    // Consume the flag even when nothing can handle it, so a stale press does not fire later.
    if (!conversation.current && !noteTaker.current) return void VoiceAssistant.consumePendingTrigger();
    if (VoiceAssistant.consumePendingTrigger()) void trigger();
    const sub = VoiceAssistant.addListener('onAssistTrigger', () => {
      VoiceAssistant.consumePendingTrigger();
      void trigger();
    });
    return () => sub.remove();
  }, [settings, trigger]);

  const noteLine = noteStatusLine(noteStatus);

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
        <SlackLine status={lightStatus} queued={queued} />
        {!!noteLine && <Text style={styles.partial}>{noteLine}</Text>}
        {!!error && <Text style={styles.error}>{error}</Text>}
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
      <SlackLine status={lightStatus} queued={queued} />
      {!!noteLine && <Text style={styles.partial}>{noteLine}</Text>}
      {!!error && <Text style={styles.error}>{error}</Text>}
      <BatteryExemptionBanner />
      <ScrollView style={styles.transcript} contentContainerStyle={{ gap: 12 }}>
        {turns.map((turn, index) => (
          <Text key={index} style={turn.role === 'user' ? styles.user : styles.assistant}>
            {turn.text}
          </Text>
        ))}
      </ScrollView>
      <View style={styles.row}>
        <Pressable style={[styles.button, styles.talk]} onPress={trigger}>
          <Text style={styles.buttonText}>{noteStatus.recording ? 'Stop note' : state === 'offline' ? 'Note' : state === 'idle' ? 'Talk' : state === 'listening' ? 'New chat' : 'Interrupt'}</Text>
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
      <SlackFields draft={draft} setDraft={setDraft} withDeepgramKey={usesClaudeApp} />
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
 * Slack light-voice mode (answering agent threads by voice) needs a Slack token in both earbud
 * modes, plus the Deepgram key, which the claude-app mode otherwise never asks for.
 */
function SlackFields({
  draft,
  setDraft,
  withDeepgramKey,
}: {
  draft: Settings;
  setDraft(settings: Settings): void;
  withDeepgramKey: boolean;
}) {
  return (
    <>
      {withDeepgramKey && (
        <>
          <Text style={styles.label}>Deepgram API key (for Slack replies and offline notes)</Text>
          <TextInput
            style={styles.input}
            value={draft.deepgramKey}
            onChangeText={(deepgramKey) => setDraft({ ...draft, deepgramKey })}
            secureTextEntry
            autoCapitalize="none"
            placeholderTextColor="#666"
          />
        </>
      )}
      <Text style={styles.label}>Slack token (xoxb-… or xoxp-…)</Text>
      <TextInput
        style={styles.input}
        value={draft.slackToken}
        onChangeText={(slackToken) => setDraft({ ...draft, slackToken })}
        secureTextEntry
        autoCapitalize="none"
        placeholder="xoxb-…"
        placeholderTextColor="#666"
      />
      <Text style={styles.hint}>Tapping a thread link in a Slack notification reads the thread aloud and posts what you say.</Text>
    </>
  );
}

/** One line of Slack light-mode status: what it is doing now and how many thread links are waiting. */
function SlackLine({ status, queued }: { status: string; queued: number }) {
  if (!status && queued === 0) return null;
  const parts = [status ? `Slack: ${status}` : 'Slack', queued > 0 ? `${queued} queued` : ''].filter(Boolean);
  return <Text style={styles.hint}>{parts.join(' · ')}</Text>;
}

/**
 * Android 14+ only lets the microphone foreground service start from the background when the
 * app is exempt from battery optimisation. Without the exemption a pocket start has to light
 * the screen first (see Conversation.handleServiceFailure), so ask for it once.
 */
function BatteryExemptionBanner() {
  const [exempt, setExempt] = useState(VoiceAssistant.isIgnoringBatteryOptimizations());
  useEffect(() => {
    // The system prompt is a separate activity; re-check when the user comes back from it.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setExempt(VoiceAssistant.isIgnoringBatteryOptimizations());
    });
    return () => sub.remove();
  }, []);

  if (exempt) return null;
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerTitle}>Let Voice Claude run with the screen off</Text>
      <Text style={styles.bannerText}>
        Android only lets the microphone start from a pocket when the app is exempt from battery optimisation. Tap to
        allow it; the screen can then stay off and locked during a chat.
      </Text>
      <Pressable style={styles.agreeButton} onPress={() => VoiceAssistant.requestIgnoreBatteryOptimizations()}>
        <Text style={styles.agreeText}>Allow</Text>
      </Pressable>
    </View>
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
