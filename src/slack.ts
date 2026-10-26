const SLACK_API = 'https://slack.com/api';

export type ThreadRef = { channel: string; ts: string };

export type SlackMessage = {
  /** Display name of the author (user or bot), already resolved. */
  author: string;
  /** Message text with Slack markup turned into something text-to-speech can read. */
  text: string;
  ts: string;
};

export type SlackThread = {
  channel: ThreadRef['channel'];
  /** Channel name without the leading '#', or 'direct message' for DMs. */
  channelName: string;
  messages: SlackMessage[];
};

/** Parses a voiceclaude://thread/<channel>/<ts> link; null for anything else. */
export function parseThreadUrl(url: string): ThreadRef | null {
  const match = /^voiceclaude:\/\/thread\/([^/?#]+)\/([^/?#]+)/i.exec(url.trim());
  if (!match) return null;
  return { channel: decodeURIComponent(match[1]), ts: decodeURIComponent(match[2]) };
}

type ApiResponse = { ok: boolean; error?: string; needed?: string; [key: string]: unknown };

const ERROR_MESSAGES: Record<string, string> = {
  invalid_auth: 'Slack rejected the token.',
  not_authed: 'No Slack token is set.',
  token_revoked: 'The Slack token was revoked.',
  account_inactive: 'The Slack account is inactive.',
  missing_scope: 'The Slack token is missing a permission scope.',
  channel_not_found: 'Slack channel not found.',
  thread_not_found: 'Slack thread not found.',
  not_in_channel: 'The Slack token is not a member of that channel.',
  ratelimited: 'Slack is rate limiting requests.',
  is_archived: 'That Slack channel is archived.',
  msg_too_long: 'The reply is too long for Slack.',
};

export class SlackError extends Error {
  constructor(public code: string, needed?: string) {
    super(ERROR_MESSAGES[code] ?? `Slack error: ${code.replace(/_/g, ' ')}` + (needed ? ` (needs ${needed})` : ''));
    this.name = 'SlackError';
  }
}

/** The request never reached Slack (no signal or the link dropped), as opposed to an API error. */
export class SlackNetworkError extends Error {}

/** Slack Web API over fetch, with a user-name cache so mentions read as names. */
export class SlackClient {
  private userNames = new Map<string, Promise<string>>();
  private channelNames = new Map<string, Promise<string>>();

  constructor(private token: string) {}

  /** Every message in a thread, oldest first, with markup stripped for speech. */
  async fetchThread(channel: string, ts: string): Promise<SlackThread> {
    const raw: RawMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call('conversations.replies', { channel, ts, limit: '200', cursor });
      raw.push(...((page.messages as RawMessage[] | undefined) ?? []));
      cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    } while (cursor);

    const [channelName, messages] = await Promise.all([
      this.channelName(channel),
      Promise.all(
        raw.map(async (message) => ({
          author: await this.authorName(message),
          text: await this.readable(message.text ?? ''),
          ts: message.ts,
        })),
      ),
    ]);
    return { channel, channelName, messages };
  }

  async postReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.call('chat.postMessage', { channel, thread_ts: threadTs, text });
  }

  async userName(userId: string): Promise<string> {
    let pending = this.userNames.get(userId);
    if (!pending) {
      pending = this.call('users.info', { user: userId })
        .then((response) => {
          const user = response.user as { name?: string; real_name?: string; profile?: { display_name?: string } };
          return user.profile?.display_name || user.real_name || user.name || userId;
        })
        .catch(() => userId);
      this.userNames.set(userId, pending);
    }
    return pending;
  }

  private channelName(channel: string): Promise<string> {
    let pending = this.channelNames.get(channel);
    if (!pending) {
      pending = this.call('conversations.info', { channel })
        .then((response) => {
          const info = response.channel as { name?: string; is_im?: boolean; is_mpim?: boolean };
          if (info.is_im) return 'direct message';
          if (info.is_mpim) return 'group message';
          return info.name || channel;
        })
        .catch(() => channel);
      this.channelNames.set(channel, pending);
    }
    return pending;
  }

  private async authorName(message: RawMessage): Promise<string> {
    if (message.user) return this.userName(message.user);
    return message.bot_profile?.name || message.username || 'bot';
  }

  /** Turns Slack mrkdwn into plain text that reads well aloud. */
  async readable(text: string): Promise<string> {
    let out = text;
    // Code first, so markup inside code is not interpreted.
    out = out.replace(/```[\s\S]*?```/g, ' code block ');
    out = out.replace(/`([^`\n]+)`/g, '$1');

    // Mentions and links: <@U…>, <@U…|name>, <#C…|name>, <!here>, <!subteam^S…|@team>, <url|label>, <url>.
    const mentions = [...out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((match) => match[1]);
    const names = new Map(await Promise.all(mentions.map(async (id) => [id, await this.userName(id)] as const)));
    out = out.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => names.get(id) ?? label ?? id);
    out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1');
    out = out.replace(/<#([A-Z0-9]+)>/g, 'channel $1');
    out = out.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');
    out = out.replace(/<!subteam\^[^|>]+\|([^>]*)>/g, '$1');
    out = out.replace(/<!date[^|>]*\|([^>]*)>/g, '$1');
    out = out.replace(/<(?:mailto:)?([^|>]+)\|([^>]*)>/g, '$2');
    out = out.replace(/<(https?:\/\/[^>]+)>/g, 'link');
    out = out.replace(/<mailto:([^>]+)>/g, '$1');

    // Emphasis markers and quotes read badly; drop them.
    out = out.replace(/(^|\s)[*_~](\S[^*_~\n]*?)[*_~](?=[\s.,!?;:]|$)/g, '$1$2');
    out = out.replace(/^>\s?/gm, '');
    out = out.replace(/:([a-z0-9_+-]+):/g, ' $1 ');

    out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '. ').replace(/\.\s*\./g, '.').trim();
  }

  private async call(method: string, params: Record<string, string | undefined>): Promise<ApiResponse> {
    if (!this.token) throw new SlackError('not_authed');
    const body: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) body[key] = value;
    let response: Response;
    try {
      response = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new SlackNetworkError(`Could not reach Slack: ${String(error)}`);
    }
    if (!response.ok) throw new Error(`Slack returned HTTP ${response.status} for ${method}.`);
    const json = (await response.json()) as ApiResponse;
    if (!json.ok) throw new SlackError(json.error ?? 'unknown_error', json.needed);
    return json;
  }
}

type RawMessage = {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
};
