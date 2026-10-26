import { AudioModule, type AudioRecorder, type RecordingOptions } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { AppState } from 'react-native';

import VoiceAssistant from '../modules/voice-assistant';
import { NetworkMonitor, PendingWait } from './network';
import { clearBackgroundTimeout, setBackgroundTimeout, sleepInBackground, TimerHandle } from './timers';

/** A note stops by itself after this long. */
export const MAX_NOTE_MS = 3 * 60_000;
/** Pause before trying the queue again after a transcription request failed. */
const FLUSH_RETRY_MS = 60_000;
const SCO_SETTLE_MS = 400;
const NOTES_DIR = 'offline-notes';
const NOTE_EXTENSION = '.m4a';
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true';
export const NOTES_PROMPT = 'Notes I took while offline: ';

/** `ready`: transcribed notes are waiting for the app to come to the foreground before delivery. */
export type NoteStatus = { recording: boolean; transcribing: boolean; queued: number; ready: boolean };

type Options = {
  deepgramKey: string;
  network: NetworkMonitor;
  useEarbudMic: boolean;
  /** Called before the recorder opens the mic, so the caller can stop its own capture first. */
  beforeRecord?(): void;
  /**
   * Receives the joined transcripts (prefixed with NOTES_PROMPT) once the network is back and the
   * app is in the foreground. Return false (or throw) to keep the notes queued for a later try.
   */
  deliver(text: string): boolean | Promise<boolean>;
  onStatus(status: NoteStatus): void;
  onError(message: string): void;
};

/**
 * Voice notes for when there is no signal: an earbud trigger records to a file in the app's
 * document directory; the files on disk are the queue. When the network becomes usable they are
 * transcribed with Deepgram's prerecorded endpoint, deleted, and handed to `deliver` as one text.
 */
export class NoteTaker {
  private recorder?: AudioRecorder;
  private starting = false;
  private stopping = false;
  private stopTimer?: TimerHandle;
  private retryTimer?: TimerHandle;
  private wait?: PendingWait;
  private flushing = false;
  /** Transcripts waiting for the app to come to the foreground (their files stay on disk). */
  private ready = false;
  /** Transcripts by file URI, so a delivery that has to wait does not pay for Deepgram twice. */
  private readonly transcripts = new Map<string, string>();
  private disposed = false;
  private readonly unsubscribeNetwork: () => void;
  private readonly appState: { remove(): void };

  constructor(private opts: Options) {
    this.unsubscribeNetwork = opts.network.onChange((online) => online && this.flushWhenUsable());
    this.appState = AppState.addEventListener('change', (next) => next === 'active' && this.flushWhenUsable());
    this.flushWhenUsable();
    this.publish();
  }

  get isRecording() {
    return !!this.recorder;
  }

  /** True while the mic is being opened, recording, or being released. */
  get busy() {
    return this.starting || this.stopping || !!this.recorder;
  }

  /** Starts a note, or stops the one being recorded. Presses during a start or stop are ignored. */
  async toggle() {
    if (this.starting || this.stopping) return;
    if (this.recorder) await this.stop();
    else await this.start();
  }

  dispose() {
    this.disposed = true;
    this.unsubscribeNetwork();
    this.appState.remove();
    this.wait?.cancel();
    clearBackgroundTimeout(this.retryTimer);
    if (this.recorder) void this.stop();
  }

  private async start() {
    this.starting = true;
    // AudioModule is the declared native object, not an ES namespace, so the lint rule cannot see the member.
    // eslint-disable-next-line import/namespace
    const recorder = new AudioModule.AudioRecorder(recordingOptions());
    try {
      this.opts.beforeRecord?.();
      VoiceAssistant.requestAudioFocus();
      if (this.opts.useEarbudMic && VoiceAssistant.setBluetoothMic(true)) {
        await sleepInBackground(SCO_SETTLE_MS);
      }
      VoiceAssistant.playTone('note');
      await recorder.prepareToRecordAsync();
      recorder.record();
      this.recorder = recorder;
      this.stopTimer = setBackgroundTimeout(() => void this.stop(), MAX_NOTE_MS);
    } catch (error) {
      recorder.release();
      this.releaseMic();
      this.opts.onError(`Could not record a note: ${String(error)}`);
    } finally {
      this.starting = false;
      this.publish();
    }
  }

  private async stop() {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = undefined;
    this.stopping = true;
    clearBackgroundTimeout(this.stopTimer);
    try {
      await recorder.stop();
      if (recorder.uri) await new File(recorder.uri).move(new File(notesDirectory(), noteFileName()));
    } catch (error) {
      this.opts.onError(`Could not save the note: ${String(error)}`);
    } finally {
      recorder.release();
      VoiceAssistant.playTone('note');
      this.releaseMic();
      this.stopping = false;
      this.publish();
      this.flushWhenUsable();
    }
  }

  private releaseMic() {
    if (this.opts.useEarbudMic) VoiceAssistant.setBluetoothMic(false);
    VoiceAssistant.abandonAudioFocus();
  }

  /** Arms a single wait for usable network while there is something to send. */
  private flushWhenUsable() {
    if (this.disposed || this.wait || this.flushing || queuedFiles().length === 0) return;
    const wait = this.opts.network.waitUntilUsable();
    this.wait = wait;
    void wait.result.then((outcome) => {
      if (this.wait !== wait) return;
      this.wait = undefined;
      if (outcome === 'usable') void this.flush();
      else if (outcome === 'gaveUp') this.flushWhenUsable(); // notes wait for as long as it takes
    });
  }

  /**
   * Transcribes the queue and hands it over. Files are deleted only once `deliver` has accepted
   * the text: delivery opens a foreground service or activity, which Android refuses from the
   * background, so it waits for the app to be active and otherwise keeps the files for a retry.
   */
  private async flush() {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    this.publish();
    try {
      const files = queuedFiles();
      for (const file of files) {
        if (!this.transcripts.has(file.uri)) this.transcripts.set(file.uri, await this.transcribe(file));
      }
      const texts = files.map((file) => this.transcripts.get(file.uri)).filter((text): text is string => !!text);
      if (texts.length === 0) return this.discard(files);
      if (AppState.currentState !== 'active') {
        this.ready = true; // the AppState listener flushes again once the app is in front
        return;
      }
      const delivered = await this.opts.deliver(NOTES_PROMPT + texts.join('\n'));
      if (delivered) this.discard(files);
      else this.retryLater();
    } catch (error) {
      this.opts.onError(`Could not deliver notes: ${String(error)}`);
      this.retryLater();
    } finally {
      this.flushing = false;
      this.publish();
    }
  }

  private discard(files: File[]) {
    this.ready = false;
    for (const file of files) {
      this.transcripts.delete(file.uri);
      file.delete();
    }
  }

  private retryLater() {
    clearBackgroundTimeout(this.retryTimer);
    this.retryTimer = setBackgroundTimeout(() => this.flushWhenUsable(), FLUSH_RETRY_MS);
  }

  private async transcribe(file: File): Promise<string> {
    const response = await fetch(DEEPGRAM_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${this.opts.deepgramKey}`, 'Content-Type': 'audio/mp4' },
      body: await file.bytes(),
    });
    if (!response.ok) throw new Error(`Deepgram HTTP ${response.status}: ${await response.text()}`);
    const json = await response.json();
    const transcript: unknown = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    return typeof transcript === 'string' ? transcript.trim() : '';
  }

  private publish() {
    this.opts.onStatus({
      recording: !!this.recorder,
      transcribing: this.flushing,
      queued: queuedFiles().length,
      ready: this.ready,
    });
  }
}

/** One line for the UI, or '' when there is nothing to say about notes. */
export function noteStatusLine({ recording, transcribing, queued, ready }: NoteStatus): string {
  if (recording) return 'Recording a note… (press again to stop)';
  if (transcribing) return 'Transcribing your notes…';
  if (queued === 0) return '';
  const notes = queued === 1 ? '1 note' : `${queued} notes`;
  return ready ? `${notes} ready, open the app` : `${notes} waiting for signal`;
}

function notesDirectory(): Directory {
  const directory = new Directory(Paths.document, NOTES_DIR);
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Unsent notes, oldest first (the timestamped names sort chronologically). */
function queuedFiles(): File[] {
  const directory = new Directory(Paths.document, NOTES_DIR);
  if (!directory.exists) return [];
  return directory
    .list()
    .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(NOTE_EXTENSION))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function noteFileName() {
  return `note-${new Date().toISOString().replace(/[:.]/g, '-')}${NOTE_EXTENSION}`;
}

/**
 * Mono 16 kHz AAC in an MP4 container: small, and Deepgram accepts it as-is. The native recorder
 * takes the Android section flattened into the common options, as expo-audio's hook does.
 */
function recordingOptions(): Partial<RecordingOptions> {
  const flattened = {
    extension: NOTE_EXTENSION,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    isMeteringEnabled: false,
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  };
  return flattened as unknown as Partial<RecordingOptions>;
}
