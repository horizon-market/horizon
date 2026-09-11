import { Client } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { LIVE_CHANNEL, type LiveEventRecord } from './messages.js';

export type Subscriber = { topics: Set<string>; send: (event: LiveEventRecord) => void };

/**
 * The API side of the live layer. One dedicated Postgres connection listens for the consumer's
 * (and the worker's) commit notifications; every wake-up reads the replay log forward from the
 * last id this process delivered, so a notification that was lost or coalesced costs nothing —
 * the next one, or the periodic poll, delivers whatever is pending in order.
 */
export class LiveBus {
  private subscribers = new Set<Subscriber>();
  private lastSeen: bigint | null = null;
  private client?: Client;
  private poll?: NodeJS.Timeout;
  private stopped = false;
  private draining = false;
  private again = false;

  constructor(private db: PrismaClient, private connectionString: string, private pollMs = 5_000) {}

  async start() {
    const latest = await this.db.liveEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    this.lastSeen = latest?.id ?? 0n;
    await this.listen();
    this.poll = setInterval(() => { void this.drain(); }, this.pollMs);
    this.poll.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    await this.client?.end().catch(() => undefined);
    for (const subscriber of this.subscribers) this.subscribers.delete(subscriber);
  }

  private async listen() {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.connectionString, application_name: 'horizon-live' });
    client.on('notification', () => { void this.drain(); });
    client.on('error', () => { void this.reconnect(); });
    client.on('end', () => { void this.reconnect(); });
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
      this.client = client;
      // Anything committed while no connection was listening is picked up now.
      void this.drain();
    } catch {
      console.error('Live bus could not listen; retrying');
      await client.end().catch(() => undefined);
      setTimeout(() => { void this.listen(); }, 5_000).unref();
    }
  }

  private async reconnect() {
    if (this.stopped) return;
    const previous = this.client;
    this.client = undefined;
    await previous?.end().catch(() => undefined);
    setTimeout(() => { void this.listen(); }, 2_000).unref();
  }

  /** Reads forward from the last delivered id. Serialised: a wake-up during a drain schedules one more. */
  private async drain() {
    if (this.draining) { this.again = true; return; }
    this.draining = true;
    try {
      do {
        this.again = false;
        const rows = await this.db.liveEvent.findMany({ where: { id: { gt: this.lastSeen ?? 0n } }, orderBy: { id: 'asc' }, take: 500 });
        for (const row of rows) {
          this.lastSeen = row.id;
          const event: LiveEventRecord = { id: row.id, type: row.type, topic: row.topic, payload: row.payload, blockNumber: row.blockNumber };
          for (const subscriber of this.subscribers) if (subscriber.topics.has(row.topic)) subscriber.send(event);
        }
        if (rows.length === 500) this.again = true;
      } while (this.again && !this.stopped);
    } catch {
      console.error('Live bus could not read the replay log');
    } finally {
      this.draining = false;
    }
  }

  subscribe(subscriber: Subscriber) {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  /**
   * What a reconnecting browser missed. If the log no longer holds the id it last saw, it is
   * told to refetch instead: replaying from a gap would present an incomplete picture as complete.
   */
  async replay(sinceId: bigint, topics: Set<string>): Promise<{ events: LiveEventRecord[]; complete: boolean }> {
    const oldest = await this.db.liveEvent.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
    if (oldest && sinceId + 1n < oldest.id) return { events: [], complete: false };
    const rows = await this.db.liveEvent.findMany({ where: { id: { gt: sinceId }, topic: { in: [...topics] } }, orderBy: { id: 'asc' }, take: 1_000 });
    return { events: rows.map(row => ({ id: row.id, type: row.type, topic: row.topic, payload: row.payload, blockNumber: row.blockNumber })), complete: rows.length < 1_000 };
  }

  get connections() { return this.subscribers.size; }
}
