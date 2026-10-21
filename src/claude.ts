import Anthropic from '@anthropic-ai/sdk';
import { fetch as expoFetch } from 'expo/fetch';

const SYSTEM = `You are Claude, talking with the user through earbuds while they are out walking. Everything you write is read aloud by text-to-speech.
- Answer in plain spoken sentences. No markdown, lists, headings, emoji, URLs or code.
- Keep answers short, two to four sentences, unless the user asks for more detail.
- The input is a speech transcript from a noisy street. If it looks garbled or cut off, ask the user to repeat instead of guessing.`;

export type ReplyOutcome = 'done' | 'refused' | 'aborted';

export class ClaudeChat {
  private client: Anthropic;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private current?: { abort(): void };
  private aborted = false;

  constructor(apiKey: string, private model = 'claude-opus-5-5') {
    // expo/fetch supports streamed response bodies, which React Native's built-in fetch does not.
    this.client = new Anthropic({
      apiKey,
      fetch: expoFetch as unknown as typeof fetch,
      dangerouslyAllowBrowser: true,
    });
  }

  reset() {
    this.messages = [];
  }

  /** Sends one user turn and streams the reply text through onText. */
  async send(text: string, onText: (delta: string) => void): Promise<ReplyOutcome> {
    this.aborted = false;
    this.messages.push({ role: 'user', content: text });
    try {
      // Server tools (web search) can pause a long turn; continue it a few times.
      for (let i = 0; i < 3; i++) {
        const stream = this.client.beta.messages.stream({
          model: this.model,
          max_tokens: 16000,
          system: SYSTEM,
          messages: this.messages,
          output_config: { effort: 'low' },
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        this.current = stream;
        stream.on('text', onText);
        const final = await stream.finalMessage();
        this.messages.push({ role: 'assistant', content: final.content });
        if (final.stop_reason === 'refusal') return 'refused';
        if (final.stop_reason !== 'pause_turn') return 'done';
      }
      return 'done';
    } catch (error) {
      if (this.aborted) return 'aborted';
      throw error;
    } finally {
      this.current = undefined;
    }
  }

  abort() {
    this.aborted = true;
    this.current?.abort();
  }
}
