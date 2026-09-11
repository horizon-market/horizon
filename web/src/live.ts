/**
 * One server-sent event stream per tab, opened at the app root and kept across page changes.
 *
 * It is a `fetch` rather than an `EventSource` because the subscription is a POST: the creation
 * tokens this browser holds travel in the body, where a URL would leak them into logs and history.
 * A dropped connection reconnects with the last id seen, and the server either replays what was
 * missed or says `snapshot.required`, which every page treats as "refetch".
 */
export type LiveEvent = { id?: string; type: string; payload: Record<string, unknown> };
type Handler = (event: LiveEvent) => void;
export type Claim = { id: string; token: string };

const parse = (block: string): LiveEvent | undefined => {
  let id: string | undefined, type = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const at = line.indexOf(':');
    const field = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  try { return { id, type, payload: JSON.parse(data.join('\n')) as Record<string, unknown> }; }
  catch { return undefined; }
};

class LiveClient {
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private controller?: AbortController;
  private lastId?: string;
  private claims: Claim[] = [];
  private delay = 1_000;
  private started = false;
  private generation = 0;
  connected = false;

  start() {
    if (this.started) return;
    this.started = true;
    void this.connect();
  }

  /** The private subscriptions. A change reopens the stream so the server can re-check them. */
  setClaims(claims: Claim[]) {
    const same = claims.length === this.claims.length && claims.every((claim, index) => this.claims[index]?.id === claim.id && this.claims[index]?.token === claim.token);
    this.claims = claims;
    if (!same && this.started) { this.controller?.abort(); }
  }

  subscribe(handler: Handler) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  onStatus(handler: (connected: boolean) => void) { this.statusHandlers.add(handler); return () => { this.statusHandlers.delete(handler); }; }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    for (const handler of this.statusHandlers) handler(value);
  }

  private async connect() {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch('/api/live', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.lastId ? { 'last-event-id': this.lastId } : {}) },
        body: JSON.stringify({ creations: this.claims }),
      });
      if (!response.ok || !response.body) throw new Error(`live_${response.status}`);
      this.setConnected(true);
      this.delay = 1_000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
          const event = parse(block);
          if (event) {
            if (event.id) this.lastId = event.id;
            for (const handler of this.handlers) handler(event);
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } catch {
      /* Reconnect below; a refused subscription or a network drop look the same from here. */
    }
    this.setConnected(false);
    if (generation !== this.generation) return;
    // An abort from setClaims reconnects at once; anything else backs off to a minute.
    const wait = controller.signal.aborted ? 0 : this.delay;
    this.delay = Math.min(60_000, this.delay * 2);
    setTimeout(() => { if (generation === this.generation) void this.connect(); }, wait);
  }
}

export const live = new LiveClient();
