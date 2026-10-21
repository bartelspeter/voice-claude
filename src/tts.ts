import * as Speech from 'expo-speech';

/** Speaks streamed text sentence by sentence so speech starts before the reply is complete. */
export class SentenceSpeaker {
  private buffer = '';
  private pending = 0;
  private finished = false;
  private generation = 0;
  private onIdle?: () => void;

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
    Speech.stop();
  }

  private speak(text: string) {
    const generation = this.generation;
    const done = () => {
      if (generation !== this.generation) return;
      this.pending--;
      this.checkIdle();
    };
    this.pending++;
    Speech.speak(text.trim(), { language: this.language, onDone: done, onStopped: done, onError: done });
  }

  private checkIdle() {
    if (!this.finished || this.pending > 0 || !this.onIdle) return;
    const onIdle = this.onIdle;
    this.onIdle = undefined;
    this.finished = false;
    onIdle();
  }
}
