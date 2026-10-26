import VoiceAssistant, { EarbudTarget } from '../modules/voice-assistant';
import { Mic } from './conversation';
import { SlackClient, SlackNetworkError, SlackThread, ThreadRef } from './slack';
import { DeepgramListener } from './stt';
import { clearBackgroundTimeout, setBackgroundTimeout, sleepInBackground, TimerHandle } from './timers';
import { SentenceSpeaker } from './tts';

export type LightReplyState = 'idle' | 'fetching' | 'reading' | 'listening' | 'posting' | 'done';
/** 'network': the thread could not be fetched for lack of signal, so the caller may retry it later. */
export type LightReplyOutcome = 'done' | 'network';

type Options = {
  mic: Mic;
  stt: DeepgramListener;
  speaker: SentenceSpeaker;
  slack: SlackClient;
  useEarbudMic: boolean;
  earbudTarget: EarbudTarget;
  onState(state: LightReplyState, detail: string): void;
  onError(message: string): void;
  /** Voice-claude mode only: hands the thread transcript to the in-app conversation. */
  onEscalate(transcript: string): void;
  /** Fires once, after the closing phrase has been spoken (or after cancel()). */
  onDone(outcome: LightReplyOutcome): void;
};

const MAX_SPOKEN_MESSAGES = 5;
const SILENCE_TIMEOUT_MS = 20_000;
const SCO_SETTLE_MS = 400;

const SKIP_COMMAND = /^(skip|no reply|cancel|never mind)[.!]?$/i;
const REPEAT_COMMAND = /^(repeat|say (that|it) again|again)[.!?]?$/i;
const ESCALATE_COMMAND = /^(open (this |it )?in claude|open with claude|escalate)[.!?]?$/i;

/**
 * Slack light-voice mode: reads one thread aloud, listens for a single utterance and posts it
 * as the reply. Short-lived; create one per thread link.
 */
export class LightReply {
  state: LightReplyState = 'idle';
  private thread?: SlackThread;
  private silenceTimer?: TimerHandle;
  private finished = false;
  private outcome: LightReplyOutcome = 'done';

  constructor(private opts: Options) {
    opts.stt.onPartial = () => this.armSilenceTimer();
    opts.stt.onUtterance = (text) => void this.handleUtterance(text);
    opts.stt.onError = (message) => opts.onError(message);
  }

  get active() {
    return this.state !== 'idle' && this.state !== 'done';
  }

  async start(ref: ThreadRef) {
    if (this.state !== 'idle') return;
    VoiceAssistant.startConversationService();
    VoiceAssistant.setShowWhenLocked(true);
    VoiceAssistant.requestAudioFocus(); // ducks music while the thread is read out
    this.setState('fetching', 'Fetching Slack thread…');
    try {
      this.thread = await this.opts.slack.fetchThread(ref.channel, ref.ts);
    } catch (error) {
      if (error instanceof SlackNetworkError || !VoiceAssistant.isOnline()) {
        this.outcome = 'network';
        return this.finish('No signal. I will read the Slack thread later.');
      }
      this.opts.onError(errorText(error));
      return this.finish(`Could not read the Slack thread. ${errorText(error)}`);
    }
    if (this.finished) return;
    if (this.thread.messages.length === 0) return this.finish('The Slack thread is empty.');
    this.readThread();
  }

  /** Stops everything without a closing phrase (used when a conversation takes over). */
  cancel() {
    if (this.finished) return;
    this.stopListening();
    this.opts.speaker.stop();
    this.teardown();
  }

  onAudio(buffer: ArrayBuffer) {
    if (this.state === 'listening') this.opts.stt.send(buffer);
  }

  private readThread() {
    const thread = this.thread!;
    const { speaker } = this.opts;
    this.setState('reading', `Reading #${thread.channelName}`);
    speaker.stop();
    speaker.push(`Slack thread in ${spoken(thread.channelName)}, ${count(thread.messages.length, 'message')}. `);
    const skipped = Math.max(0, thread.messages.length - MAX_SPOKEN_MESSAGES);
    if (skipped > 0) speaker.push(`${count(skipped, 'earlier message')} skipped. `);
    for (const message of thread.messages.slice(skipped)) {
      speaker.push(`${message.author}: ${ensurePeriod(message.text || 'empty message')} `);
    }
    speaker.push('Your reply? ');
    speaker.end(() => void this.listen());
  }

  private async listen() {
    if (this.finished) return;
    this.setState('listening', 'Listening for your reply…');
    if (this.opts.useEarbudMic && VoiceAssistant.setBluetoothMic(true)) {
      await sleepInBackground(SCO_SETTLE_MS);
    }
    if (this.state !== 'listening') return;
    try {
      const sampleRate = await this.opts.mic.start();
      this.opts.stt.start(sampleRate);
      this.armSilenceTimer();
    } catch (error) {
      this.stopListening(); // releases the headset mic route that was opened above
      this.opts.onError(`Microphone failed: ${String(error)}`);
      this.finish('The microphone failed. No reply posted.');
    }
  }

  private stopListening() {
    clearBackgroundTimeout(this.silenceTimer);
    this.opts.stt.stop();
    this.opts.mic.stop();
    if (this.opts.useEarbudMic) VoiceAssistant.setBluetoothMic(false);
  }

  private armSilenceTimer() {
    clearBackgroundTimeout(this.silenceTimer);
    this.silenceTimer = setBackgroundTimeout(() => {
      if (this.state !== 'listening') return;
      this.stopListening();
      this.finish('No reply posted.');
    }, SILENCE_TIMEOUT_MS);
  }

  private async handleUtterance(text: string) {
    if (this.state !== 'listening') return;
    this.stopListening();
    const utterance = text.trim();

    if (SKIP_COMMAND.test(utterance)) return this.finish('Skipped.');
    if (REPEAT_COMMAND.test(utterance)) return this.readThread();
    if (ESCALATE_COMMAND.test(utterance)) return this.escalate();

    const thread = this.thread!;
    this.setState('posting', 'Posting reply…');
    try {
      await this.opts.slack.postReply(thread.channel, thread.messages[0].ts, utterance);
      this.finish('Posted.');
    } catch (error) {
      this.opts.onError(errorText(error));
      this.finish(`Posting failed. ${errorText(error)}`);
    }
  }

  private escalate() {
    const transcript = this.transcript();
    if (this.opts.earbudTarget === 'claude-app') {
      let opened = false;
      try {
        opened = VoiceAssistant.sendToClaudeApp(transcript);
      } catch {
        // startActivity can throw (e.g. from the background); treated like "not opened".
      }
      if (!opened) return this.finish('Could not open the Claude app.');
      // The Claude app is in front now; stay quiet and let it talk.
      this.teardown();
      return;
    }
    this.teardown();
    this.opts.onEscalate(transcript);
  }

  /** Plain-text version of the whole thread for handing over to Claude. */
  transcript(): string {
    const thread = this.thread!;
    const header = `Here is a Slack thread I was asked about, from #${thread.channelName}:`;
    const lines = thread.messages.map((message) => `${message.author}: ${message.text}`);
    return [header, '', ...lines, '', 'Help me decide what to answer.'].join('\n');
  }

  private finish(closing: string) {
    if (this.finished) return;
    this.setState('done', closing);
    this.opts.speaker.say(closing, () => this.teardown());
  }

  private teardown() {
    if (this.finished) return;
    this.finished = true;
    clearBackgroundTimeout(this.silenceTimer);
    VoiceAssistant.abandonAudioFocus();
    VoiceAssistant.stopConversationService();
    VoiceAssistant.setShowWhenLocked(false);
    this.setState('done', '');
    this.opts.onDone(this.outcome);
  }

  private setState(state: LightReplyState, detail: string) {
    this.state = state;
    this.opts.onState(state, detail);
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function ensurePeriod(text: string) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** '#dev-ops_team' is spoken as 'dev ops team'. */
function spoken(channelName: string) {
  return channelName.replace(/[-_]+/g, ' ');
}
