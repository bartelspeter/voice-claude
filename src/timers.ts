/**
 * Timers that keep running while the app is not in front.
 *
 * Do not use the global setTimeout/setInterval in session code (conversation, notes, light mode,
 * network waits, request retries). React Native's JavaTimerManager pauses every JS timer while
 * the Android activity is paused (`onHostPause`) unless a headless task is running, and this
 * app runs its conversations from the lock screen with the activity behind the keyguard. The
 * result was a chat stuck in "Listening…" forever because the 30 s idle timeout never fired.
 *
 * These wrappers keep the timer on the Android main looper (see `startTimer` in
 * modules/voice-assistant) and call back into JS through the module's `onTimer` event, which
 * is delivered whether or not the activity is paused. They have the same shape as the globals,
 * so call sites only change the function name. Plain timers are fine for code that only matters
 * while the app is active (App.tsx's waitForActive, UI debouncing).
 */
import VoiceAssistant from '../modules/voice-assistant';

/** Opaque handle from `setBackgroundTimeout`/`setBackgroundInterval`. */
export type TimerHandle = { readonly id: string };

type Entry = { fn: () => void; ms: number; repeat: boolean };

/** Armed timers by id; an entry is removed when its one-shot fires or either clear is called. */
const entries = new Map<string, Entry>();
let counter = 0;

VoiceAssistant.addListener('onTimer', ({ id }) => {
  const entry = entries.get(id);
  if (!entry) return; // cleared after the event was sent but before it was handled
  // Re-arm before the callback so a callback that clears the interval wins.
  if (entry.repeat) VoiceAssistant.startTimer(id, entry.ms);
  else entries.delete(id);
  entry.fn();
});

function arm(fn: () => void, ms: number, repeat: boolean): TimerHandle {
  const id = String(++counter);
  entries.set(id, { fn, ms, repeat });
  VoiceAssistant.startTimer(id, ms);
  return { id };
}

function disarm(handle: TimerHandle | undefined) {
  if (!handle || !entries.delete(handle.id)) return; // unknown, already fired, or already cleared
  VoiceAssistant.cancelTimer(handle.id);
}

/** Like setTimeout, but fires while the activity is paused too. */
export function setBackgroundTimeout(fn: () => void, ms: number): TimerHandle {
  return arm(fn, ms, false);
}

/** Like clearTimeout; a no-op for undefined, fired or already cleared handles. */
export function clearBackgroundTimeout(handle: TimerHandle | undefined) {
  disarm(handle);
}

/** Like setInterval, but keeps ticking while the activity is paused. */
export function setBackgroundInterval(fn: () => void, ms: number): TimerHandle {
  return arm(fn, ms, true);
}

/** Like clearInterval; a no-op for undefined or already cleared handles. */
export function clearBackgroundInterval(handle: TimerHandle | undefined) {
  disarm(handle);
}

/** Resolves after `ms`, or as soon as `signal` aborts (never rejects). */
export function sleepInBackground(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const handle = setBackgroundTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearBackgroundTimeout(handle);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
