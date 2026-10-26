import type Anthropic from '@anthropic-ai/sdk';
import { fetch } from 'expo/fetch';

import VoiceAssistant from '../modules/voice-assistant';

// The Anthropic SDK's circular imports crash Metro's React Refresh at startup, so this
// calls the Messages API directly. Only SDK types are imported (erased at build time).

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are Claude, talking with the user through earbuds while they are out walking. Everything you write is read aloud by text-to-speech.
- Answer in plain spoken sentences. No markdown, lists, headings, emoji, URLs or code.
- Keep answers short, two to four sentences, unless the user asks for more detail.
- The input is a speech transcript from a noisy street. If it looks garbled or cut off, ask the user to repeat instead of guessing.`;

/** Backoff before each retry of a failed request; its length is the number of retries. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export type ReplyOutcome = 'done' | 'refused' | 'aborted';

/** The request could not reach the API (or the device is offline): the caller should wait for signal. */
export class ClaudeNetworkError extends Error {}

class HttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`HTTP ${status}: ${detail}`);
  }
}

/** An error event on the response stream, such as overloaded_error. */
class ApiStreamError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export class ClaudeChat {
  // Assistant turns are kept as plain text; thinking and search blocks aren't needed for later turns.
  private messages: Anthropic.MessageParam[] = [];
  private controller?: AbortController;

  constructor(
    private apiKey: string,
    private model = 'claude-opus-5-5',
    private isOnline: () => boolean = () => VoiceAssistant.isOnline(),
  ) {}

  reset() {
    this.messages = [];
  }

  /**
   * Sends one user turn and streams the reply text through onText. Network failures, 5xx and
   * overloaded responses are retried with backoff while the device is online; a retry re-sends the
   * same turn. A turn that gets no reply is dropped from the history again, so re-sending it later
   * (after a signal drop) does not duplicate it.
   */
  async send(text: string, onText: (delta: string) => void): Promise<ReplyOutcome> {
    // Bookkeeping stays on this array: reset() during the request swaps in a new history, and an
    // aborted partial reply must not leak into that one.
    const messages = this.messages;
    const userTurn: Anthropic.MessageParam = { role: 'user', content: text };
    messages.push(userTurn);
    const controller = new AbortController();
    this.controller = controller;
    let reply = '';
    let stopReason: string | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          stopReason = await this.stream(controller.signal, messages, (delta) => {
            reply += delta;
            onText(delta);
          });
          break;
        } catch (error) {
          if (controller.signal.aborted) return 'aborted';
          // Once some of the reply has been spoken a retry would repeat it; let the caller decide.
          const canRetry = !reply && isRetryable(error) && attempt < RETRY_DELAYS_MS.length && this.isOnline();
          if (!canRetry) {
            if (isNetworkFailure(error) || !this.isOnline()) throw new ClaudeNetworkError(String(error));
            throw error;
          }
          await sleep(RETRY_DELAYS_MS[attempt], controller.signal);
        }
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (this.messages === messages) {
        if (reply) messages.push({ role: 'assistant', content: reply });
        else if (messages[messages.length - 1] === userTurn) messages.pop();
      }
    }
    return stopReason === 'refusal' ? 'refused' : 'done';
  }

  abort() {
    this.controller?.abort();
  }

  /** One request attempt; resolves with the stop reason once the stream ends. */
  private async stream(
    signal: AbortSignal,
    messages: Anthropic.MessageParam[],
    onText: (delta: string) => void,
  ): Promise<string | null> {
    const response = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 16000,
        stream: true,
        system: SYSTEM,
        messages,
        output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        fallbacks: 'default',
      }),
    });
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, await response.text());
    }

    let stopReason: string | null = null;
    for await (const event of readServerSentEvents(response.body)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onText(event.delta.text);
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason;
      } else if (event.type === 'error') {
        throw new ApiStreamError(event.error.type ?? 'api_error', event.error.message);
      }
    }
    return stopReason;
  }
}

/** Anything that isn't a definite answer from the API: the request never arrived or the link died. */
function isNetworkFailure(error: unknown): boolean {
  return !(error instanceof HttpError) && !(error instanceof ApiStreamError);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500; // includes 529 overloaded
  if (error instanceof ApiStreamError) return error.type === 'overloaded_error' || error.type === 'api_error';
  return true;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

type StreamEvent =
  | Anthropic.RawMessageStreamEvent
  | { type: 'error'; error: { type?: string; message: string } };

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data) as StreamEvent;
    }
  }
}
