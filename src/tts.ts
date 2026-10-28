/**
 * Text-to-speech through the voice-assistant module's `speak`.
 *
 * Not expo-speech: that shut its engine down with the activity and never rebound it, so once a
 * conversation had been running behind the keyguard long enough for Android to destroy the
 * activity, every later utterance failed silently and the speaker waited forever (the app sat
 * on "Speaking…"). The module's engine lives as long as the app process and always answers
 * with exactly one of onSpeechDone / onSpeechStopped / onSpeechError per utterance id.
 */
import VoiceAssistant from '../modules/voice-assistant';

/** Per-utterance completion callbacks by id; an entry is removed on its first terminal event. */
const settled = new Map<string, () => void>();
let counter = 0;

function settle({ id }: { id: string }) {
  const done = settled.get(id);
  if (!done) return; // stopped by us already, or a duplicate event
  settled.delete(id);
  done();
}

// Done, stopped and error all count the same: the utterance is no longer pending.
VoiceAssistant.addListener('onSpeechDone', settle);
VoiceAssistant.addListener('onSpeechStopped', settle);
VoiceAssistant.addListener('onSpeechError', settle);

/** Speaks streamed text sentence by sentence so speech starts before the reply is complete. */
export class SentenceSpeaker {
  private buffer = '';
  private pending = 0;
  private finished = false;
  private generation = 0;
  private onIdle?: () => void;
  /** Ids of this speaker's utterances still waiting for a terminal event. */
  private ids = new Set<string>();

  constructor(private language = 'en-US') {}

  push(delta: string) {
    this.buffer += delta;
    let match: RegExpMatchArray | null;
    while ((match = this.buffer.match(/^([\s\S]+?[.!?])\s+/))) {
      this.speak(match[1]);
      this.buffer = this.buffer.slice(match[0].length);
    }
  }

  /** Flushes the remaining text; onIdle fires once everything has been spoken. */
  end(onIdle: () => void) {
    if (this.buffer.trim()) this.speak(this.buffer);
    this.buffer = '';
    this.finished = true;
    this.onIdle = onIdle;
    this.checkIdle();
  }

  say(text: string, onIdle: () => void) {
    this.stop();
    this.push(text + ' ');
    this.end(onIdle);
  }

  stop() {
    this.generation++;
    this.buffer = '';
    this.pending = 0;
    this.finished = false;
    this.onIdle = undefined;
    // Forget the old utterances before the stop events arrive, so they can't touch whatever
    // `say` queues next; the generation check below covers an event already in flight.
    for (const id of this.ids) settled.delete(id);
    this.ids.clear();
    VoiceAssistant.stopSpeaking();
  }

  private speak(text: string) {
    const generation = this.generation;
    const id = `u${++counter}`;
    this.pending++;
    this.ids.add(id);
    settled.set(id, () => {
      this.ids.delete(id);
      if (generation !== this.generation) return;
      this.pending--;
      this.checkIdle();
    });
    VoiceAssistant.speak(id, text.trim(), this.language);
  }

  private checkIdle() {
    if (!this.finished || this.pending > 0 || !this.onIdle) return;
    const onIdle = this.onIdle;
    this.onIdle = undefined;
    this.finished = false;
    onIdle();
  }
}
