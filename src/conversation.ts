import VoiceAssistant from '../modules/voice-assistant';
import { ClaudeChat } from './claude';
import { DeepgramListener } from './stt';
import { SentenceSpeaker } from './tts';

export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking';
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
  useEarbudMic: boolean;
  onState(state: ConversationState): void;
  onPartial(text: string): void;
  onTurn(turn: Turn): void;
  onError(message: string): void;
};

const IDLE_TIMEOUT_MS = 30_000;
const SCO_SETTLE_MS = 400;
const END_COMMAND = /^(stop|goodbye|bye|that's all|thanks,? that's all)[.!]?$/i;
const NEW_CHAT_COMMAND = /^(new (chat|conversation)|start over)[.!]?$/i;

/**
 * Hands-free turn-taking: listen, send to Claude, speak the reply, listen again.
 * The assistant trigger (earbud long press) starts a chat, interrupts Claude, or starts over.
 */
export class Conversation {
  state: ConversationState = 'idle';
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(private opts: Options) {
    opts.stt.onPartial = (text) => {
      this.armIdleTimer();
      opts.onPartial(text);
    };
    opts.stt.onUtterance = (text) => void this.handleUtterance(text);
    opts.stt.onError = (message) => opts.onError(message);
  }

  trigger() {
    switch (this.state) {
      case 'idle':
        VoiceAssistant.startConversationService();
        VoiceAssistant.setShowWhenLocked(true);
        this.opts.claude.reset();
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
        void this.listen();
        break;
    }
  }

  end(sayGoodbye = true) {
    this.stopListening();
    this.opts.claude.abort();
    this.opts.speaker.stop();
    if (sayGoodbye) this.opts.speaker.say('Bye.', () => {});
    VoiceAssistant.stopConversationService();
    VoiceAssistant.setShowWhenLocked(false);
    this.setState('idle');
  }

  onAudio(buffer: ArrayBuffer) {
    if (this.state === 'listening') this.opts.stt.send(buffer);
  }

  private prompt(text: string) {
    this.setState('speaking');
    this.opts.speaker.say(text, () => void this.listen());
  }

  private async listen() {
    this.setState('listening');
    this.opts.onPartial('');
    if (this.opts.useEarbudMic && VoiceAssistant.setBluetoothMic(true)) {
      await new Promise((resolve) => setTimeout(resolve, SCO_SETTLE_MS));
    }
    if (this.state !== 'listening') return;
    try {
      const sampleRate = await this.opts.mic.start();
      this.opts.stt.start(sampleRate);
      this.armIdleTimer();
    } catch (error) {
      this.opts.onError(`Microphone failed: ${String(error)}`);
      this.end(false);
    }
  }

  private stopListening() {
    clearTimeout(this.idleTimer);
    this.opts.stt.stop();
    this.opts.mic.stop();
    // Release the headset mic so the reply plays over normal (A2DP) audio.
    if (this.opts.useEarbudMic) VoiceAssistant.setBluetoothMic(false);
  }

  private armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end(), IDLE_TIMEOUT_MS);
  }

  private async handleUtterance(text: string) {
    if (this.state !== 'listening') return;
    this.stopListening();
    this.opts.onTurn({ role: 'user', text });

    if (END_COMMAND.test(text)) return this.end();
    if (NEW_CHAT_COMMAND.test(text)) {
      this.opts.claude.reset();
      return this.prompt('New chat.');
    }

    this.setState('thinking');
    const { speaker } = this.opts;
    let reply = '';
    try {
      const outcome = await this.opts.claude.send(text, (delta) => {
        if (this.state === 'thinking') this.setState('speaking');
        reply += delta;
        speaker.push(delta);
      });
      if (outcome === 'aborted') return;
      if (outcome === 'refused' && !reply) {
        reply = "Sorry, I can't help with that.";
        speaker.push(reply + ' ');
      }
      this.opts.onTurn({ role: 'assistant', text: reply });
      this.setState('speaking');
      speaker.end(() => void this.listen());
    } catch (error) {
      this.opts.onError(`Claude request failed: ${String(error)}`);
      this.prompt('Sorry, something went wrong. Try again.');
    }
  }

  private setState(state: ConversationState) {
    this.state = state;
    this.opts.onState(state);
  }
}
