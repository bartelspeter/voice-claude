import VoiceAssistant from '../modules/voice-assistant';
import { ClaudeChat, ClaudeNetworkError } from './claude';
import { NetworkMonitor, PendingWait } from './network';
import { DeepgramListener } from './stt';
import { clearBackgroundTimeout, setBackgroundTimeout, sleepInBackground, TimerHandle } from './timers';
import { SentenceSpeaker } from './tts';

export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline';
export type Turn = { role: 'user' | 'assistant'; text: string };

export type Mic = {
  /** Starts capturing 16-bit mono PCM and resolves with the actual sample rate. */
  start(): Promise<number>;
  stop(): void;
};

type Options = {
  mic: Mic;
  claude: ClaudeChat;
  stt: DeepgramListener;
  speaker: SentenceSpeaker;
  network: NetworkMonitor;
  useEarbudMic: boolean;
  /** Checked when the network is back; false (e.g. a note is recording) holds the resume until `retryResume()`. */
  canResume?(): boolean;
  onState(state: ConversationState): void;
  onPartial(text: string): void;
  onTurn(turn: Turn): void;
  onError(message: string): void;
};

const IDLE_TIMEOUT_MS = 30_000;
const SCO_SETTLE_MS = 400;
/** Signal drops in a row without a completed exchange before we stop blaming the network. */
const MAX_OFFLINE_STREAK = 3;
const END_COMMAND = /^(stop|goodbye|bye|that's all|thanks,? that's all)[.!]?$/i;
const NEW_CHAT_COMMAND = /^(new (chat|conversation)|start over)[.!]?$/i;

/**
 * Hands-free turn-taking: listen, send to Claude, speak the reply, listen again.
 * The assistant trigger (earbud long press) starts a chat, interrupts Claude, or starts over.
 *
 * A signal drop parks the chat in 'offline' (history kept, audio focus released so whatever
 * played before resumes) until the network is usable again, then picks up where it left off.
 */
export class Conversation {
  state: ConversationState = 'idle';
  private idleTimer?: TimerHandle;
  private wait?: PendingWait;
  /** The user turn being answered; re-sent after a signal drop if no reply came through. */
  private unanswered?: string;
  private offlineStreak = 0;
  /** Claude requests in progress (streaming included); a counter, since an aborted one ends after its replacement starts. */
  private requestsInFlight = 0;
  /** The network came back but `canResume` said no; `retryResume()` picks it up. */
  private resumeBlocked = false;
  private readonly unsubscribeNetwork: () => void;

  constructor(private opts: Options) {
    opts.stt.onPartial = (text) => {
      // Deepgram keeps sending empty results through silence; only real speech postpones the timeout.
      if (text) this.armIdleTimer();
      opts.onPartial(text);
    };
    opts.stt.onUtterance = (text) => void this.handleUtterance(text);
    opts.stt.onError = () => this.goOffline('Speech recognition connection failed');
    opts.stt.onClose = () => this.goOffline('Speech recognition connection closed');
    this.unsubscribeNetwork = opts.network.onChange((online) => {
      if (online) return;
      // A reply that has fully arrived can finish playing; the next listen or send fails into offline by itself.
      if (this.state === 'speaking' && this.requestsInFlight === 0) return;
      this.goOffline('No signal');
    });
  }

  trigger() {
    switch (this.state) {
      case 'idle':
        this.startSession();
        this.prompt('Yes?');
        break;
      case 'listening':
        this.stopListening();
        this.opts.claude.reset();
        this.prompt('New chat.');
        break;
      case 'thinking':
      case 'speaking':
        this.opts.claude.abort();
        this.opts.speaker.stop();
        this.unanswered = undefined;
        void this.listen();
        break;
      case 'offline':
        // App.tsx routes the trigger to the offline note taker instead.
        break;
    }
  }

  /**
   * Starts a fresh chat whose first user turn is `openingPrompt` (no "Yes?"): the reply is
   * spoken, then the conversation listens as usual. Any chat in progress is replaced.
   */
  startWith(openingPrompt: string) {
    this.halt();
    this.startSession();
    this.opts.onTurn({ role: 'user', text: openingPrompt });
    void this.ask(openingPrompt);
  }

  end(sayGoodbye = true) {
    this.halt();
    if (sayGoodbye) this.opts.speaker.say('Bye.', () => VoiceAssistant.abandonAudioFocus());
    else VoiceAssistant.abandonAudioFocus();
    VoiceAssistant.stopConversationService();
    VoiceAssistant.setShowWhenLocked(false);
    this.setState('idle');
  }

  /** Ends the chat and detaches from the network monitor; the instance is unusable afterwards. */
  dispose() {
    this.end(false);
    this.unsubscribeNetwork();
  }

  onAudio(buffer: ArrayBuffer) {
    if (this.state === 'listening') this.opts.stt.send(buffer);
  }

  /**
   * Parks the chat until the network is usable again: mic, STT, Claude and speech stop, the
   * history stays, and audio focus is released. Resumes with "Back." (re-sending an unanswered
   * turn) or gives up after GIVE_UP_MS. No-op when idle or already offline.
   */
  goOffline(reason: string) {
    if (this.state === 'idle' || this.state === 'offline') return;
    const unanswered = this.unanswered;
    this.halt();
    this.unanswered = unanswered;
    VoiceAssistant.abandonAudioFocus();
    this.setState('offline');

    if (++this.offlineStreak > MAX_OFFLINE_STREAK) {
      this.opts.onError(`${reason} repeatedly. Check the keys and the connection.`);
      return this.end(false);
    }
    this.awaitSignal();
  }

  /** Re-arms the wait for a parked chat whose resume `canResume` held back (e.g. once a note stops). */
  retryResume() {
    if (this.state !== 'offline' || !this.resumeBlocked) return;
    this.resumeBlocked = false;
    this.awaitSignal();
  }

  private awaitSignal() {
    const wait = this.opts.network.waitUntilUsable();
    this.wait = wait;
    void wait.result.then((outcome) => {
      if (this.wait !== wait || this.state !== 'offline') return;
      this.wait = undefined;
      if (outcome === 'gaveUp') {
        VoiceAssistant.playTone('gaveUp');
        this.end(false);
      } else if (outcome === 'usable') {
        if (this.opts.canResume?.() === false) this.resumeBlocked = true;
        else this.resume();
      }
    });
  }

  private resume() {
    VoiceAssistant.requestAudioFocus();
    VoiceAssistant.playTone('back');
    const text = this.unanswered;
    this.unanswered = undefined;
    this.setState('speaking');
    this.opts.speaker.say('Back.', () => (text ? void this.ask(text) : void this.listen()));
  }

  private startSession() {
    VoiceAssistant.startConversationService();
    VoiceAssistant.setShowWhenLocked(true);
    VoiceAssistant.requestAudioFocus();
    this.opts.claude.reset();
    this.offlineStreak = 0;
  }

  /** Stops everything that is running without changing state or releasing the session. */
  private halt() {
    this.wait?.cancel();
    this.wait = undefined;
    this.resumeBlocked = false;
    this.unanswered = undefined;
    this.stopListening();
    this.opts.claude.abort();
    this.opts.speaker.stop();
    this.opts.onPartial('');
  }

  private prompt(text: string) {
    this.setState('speaking');
    this.opts.speaker.say(text, () => void this.listen());
  }

  private async listen() {
    this.setState('listening');
    this.opts.onPartial('');
    if (this.opts.useEarbudMic && VoiceAssistant.setBluetoothMic(true)) {
      await sleepInBackground(SCO_SETTLE_MS);
    }
    if (this.state !== 'listening') return;
    try {
      const sampleRate = await this.opts.mic.start();
      if (this.state !== 'listening') return this.opts.mic.stop();
      this.opts.stt.start(sampleRate);
      this.armIdleTimer();
    } catch (error) {
      this.opts.onError(`Microphone failed: ${String(error)}`);
      this.end(false);
    }
  }

  private stopListening() {
    clearBackgroundTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.opts.stt.stop();
    this.opts.mic.stop();
    // Release the headset mic so the reply plays over normal (A2DP) audio.
    if (this.opts.useEarbudMic) VoiceAssistant.setBluetoothMic(false);
  }

  /** Ends the chat after IDLE_TIMEOUT_MS of silence. Armed when listening starts; re-armed only by real speech. */
  private armIdleTimer() {
    clearBackgroundTimeout(this.idleTimer);
    this.idleTimer = setBackgroundTimeout(() => this.end(), IDLE_TIMEOUT_MS);
  }

  private async handleUtterance(text: string) {
    if (this.state !== 'listening') return;
    this.stopListening();
    this.offlineStreak = 0; // speech got through, so the link works
    this.opts.onTurn({ role: 'user', text });

    if (END_COMMAND.test(text)) return this.end();
    if (NEW_CHAT_COMMAND.test(text)) {
      this.opts.claude.reset();
      return this.prompt('New chat.');
    }
    await this.ask(text);
  }

  /** Sends one user turn, speaks the streamed reply, then listens again. */
  private async ask(text: string) {
    this.setState('thinking');
    this.unanswered = text;
    const { speaker } = this.opts;
    let reply = '';
    this.requestsInFlight++;
    try {
      const outcome = await this.opts.claude.send(text, (delta) => {
        if (this.state === 'thinking') this.setState('speaking');
        if (!reply) this.unanswered = undefined; // part of the reply was heard; don't re-ask later
        reply += delta;
        speaker.push(delta);
      }).finally(() => {
        this.requestsInFlight--;
      });
      if (outcome === 'aborted') return;
      this.unanswered = undefined;
      this.offlineStreak = 0;
      if (outcome === 'refused' && !reply) {
        reply = "Sorry, I can't help with that.";
        speaker.push(reply + ' ');
      }
      this.opts.onTurn({ role: 'assistant', text: reply });
      this.setState('speaking');
      speaker.end(() => void this.listen());
    } catch (error) {
      if (this.state !== 'thinking' && this.state !== 'speaking') return; // parked or ended meanwhile
      if (error instanceof ClaudeNetworkError || !this.opts.network.isOnline()) {
        return this.goOffline('Claude request failed');
      }
      this.unanswered = undefined;
      this.opts.onError(`Claude request failed: ${String(error)}`);
      this.prompt('Sorry, something went wrong. Try again.');
    }
  }

  private setState(state: ConversationState) {
    this.state = state;
    this.opts.onState(state);
  }
}
