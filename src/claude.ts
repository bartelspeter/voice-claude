import type Anthropic from '@anthropic-ai/sdk';
import { fetch } from 'expo/fetch';

// The Anthropic SDK's circular imports crash Metro's React Refresh at startup, so this
// calls the Messages API directly. Only SDK types are imported (erased at build time).

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You are Claude, talking with the user through earbuds while they are out walking. Everything you write is read aloud by text-to-speech.
- Answer in plain spoken sentences. No markdown, lists, headings, emoji, URLs or code.
- Keep answers short, two to four sentences, unless the user asks for more detail.
- The input is a speech transcript from a noisy street. If it looks garbled or cut off, ask the user to repeat instead of guessing.`;

export type ReplyOutcome = 'done' | 'refused' | 'aborted';

export class ClaudeChat {
  // Assistant turns are kept as plain text; thinking and search blocks aren't needed for later turns.
  private messages: Anthropic.MessageParam[] = [];
  private controller?: AbortController;

  constructor(private apiKey: string, private model = 'claude-opus-5-5') {}

  reset() {
    this.messages = [];
  }

  /** Sends one user turn and streams the reply text through onText. */
  async send(text: string, onText: (delta: string) => void): Promise<ReplyOutcome> {
    this.messages.push({ role: 'user', content: text });
    const controller = new AbortController();
    this.controller = controller;
    let reply = '';
    let stopReason: string | null = null;
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
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
          messages: this.messages,
          output_config: { effort: 'low' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
          fallbacks: 'default',
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      for await (const event of readServerSentEvents(response.body)) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          reply += event.delta.text;
          onText(event.delta.text);
        } else if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason;
        } else if (event.type === 'error') {
          throw new Error(event.error.message);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return 'aborted';
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (reply) this.messages.push({ role: 'assistant', content: reply });
    }
    return stopReason === 'refusal' ? 'refused' : 'done';
  }

  abort() {
    this.controller?.abort();
  }
}

type StreamEvent = Anthropic.RawMessageStreamEvent | { type: 'error'; error: { message: string } };

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
