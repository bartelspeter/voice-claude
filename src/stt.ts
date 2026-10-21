const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

/** Streams 16-bit PCM to Deepgram and reports whole utterances once the speaker pauses. */
export class DeepgramListener {
  onPartial?: (text: string) => void;
  onUtterance?: (text: string) => void;
  onError?: (message: string) => void;

  private ws?: WebSocket;
  private finals: string[] = [];
  private queued: ArrayBuffer[] = [];

  constructor(private apiKey: string, private language = 'en') {}

  start(sampleRate: number) {
    this.stop();
    const params = {
      model: 'nova-3',
      language: this.language,
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      smart_format: 'true',
      interim_results: 'true',
      // Walking pauses are long; wait ~1s of silence before ending the turn.
      endpointing: '1000',
      utterance_end_ms: '1500',
      vad_events: 'true',
    };
    const query = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    const ws = new WebSocket(`${DEEPGRAM_URL}?${query}`, ['token', this.apiKey]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      for (const buffer of this.queued) ws.send(buffer);
      this.queued = [];
    };
    ws.onmessage = (event) => this.handleMessage(String(event.data));
    ws.onerror = () => this.onError?.('Speech recognition connection failed');
    this.ws = ws;
  }

  send(buffer: ArrayBuffer) {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buffer);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.queued.push(buffer);
  }

  stop() {
    const ws = this.ws;
    this.ws = undefined;
    this.finals = [];
    this.queued = [];
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
    ws.close();
  }

  private handleMessage(raw: string) {
    const message = JSON.parse(raw);
    if (message.type === 'Results') {
      const transcript: string = message.channel?.alternatives?.[0]?.transcript ?? '';
      if (message.is_final && transcript) this.finals.push(transcript);
      const partial = message.is_final ? '' : transcript;
      this.onPartial?.([...this.finals, partial].join(' ').trim());
      if (message.speech_final) this.flush();
    } else if (message.type === 'UtteranceEnd') {
      this.flush();
    }
  }

  private flush() {
    const text = this.finals.join(' ').trim();
    this.finals = [];
    if (text) this.onUtterance?.(text);
  }
}
