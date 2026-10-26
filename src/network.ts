import VoiceAssistant from '../modules/voice-assistant';
import { clearBackgroundInterval, clearBackgroundTimeout, setBackgroundInterval, setBackgroundTimeout } from './timers';

/** How often a waiting caller re-probes the connection while the device says it is online. */
export const PROBE_INTERVAL_MS = 30_000;
/** How long a parked conversation waits for signal before it gives up. */
export const GIVE_UP_MS = 20 * 60_000;

export type ProbeResult = { ok: boolean; latencyMs: number; downKbps: number; upKbps: number };
export type WaitOutcome = 'usable' | 'gaveUp' | 'cancelled';
export type WaitOptions = { intervalMs?: number; giveUpMs?: number };
export type PendingWait = { result: Promise<WaitOutcome>; cancel(): void };

/**
 * Connectivity as the native side sees it. "Online" is the OS flag; "usable" means the native
 * probe (latency and throughput thresholds live in Kotlin) says the link can carry a conversation.
 */
export class NetworkMonitor {
  isOnline(): boolean {
    return VoiceAssistant.isOnline();
  }

  /** Never rejects; `ok` is false when offline or too slow. */
  probe(): Promise<ProbeResult> {
    return VoiceAssistant.probeNetwork();
  }

  /** Fires on every OS connectivity change. Returns the unsubscribe function. */
  onChange(listener: (online: boolean) => void): () => void {
    const subscription = VoiceAssistant.addListener('onNetworkChange', ({ online }) => listener(online));
    return () => subscription.remove();
  }

  /**
   * Resolves 'usable' as soon as a probe passes: immediately if possible, otherwise whenever the
   * device comes back online or every `intervalMs` while it claims to be online. 'gaveUp' after
   * `giveUpMs`; 'cancelled' if `cancel()` is called first.
   */
  waitUntilUsable({ intervalMs = PROBE_INTERVAL_MS, giveUpMs = GIVE_UP_MS }: WaitOptions = {}): PendingWait {
    let finish!: (outcome: WaitOutcome) => void;
    const result = new Promise<WaitOutcome>((resolve) => (finish = resolve));
    let done = false;
    let probing = false;

    const settle = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearBackgroundTimeout(deadline);
      clearBackgroundInterval(ticker);
      unsubscribe();
      finish(outcome);
    };
    const check = async () => {
      if (done || probing || !this.isOnline()) return;
      probing = true;
      const { ok } = await this.probe();
      probing = false;
      if (ok) settle('usable');
    };

    const deadline = setBackgroundTimeout(() => settle('gaveUp'), giveUpMs);
    const ticker = setBackgroundInterval(() => void check(), intervalMs);
    const unsubscribe = this.onChange((online) => online && void check());
    void check();
    return { result, cancel: () => settle('cancelled') };
  }
}
