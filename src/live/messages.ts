import type { Prisma } from '@prisma/client';

/** The Postgres channel the API listens on. Payloads carry ids only; rows are read back from LiveEvent. */
export const LIVE_CHANNEL = 'horizon_live';
export const PUBLIC_TOPIC = 'public';
export const creationTopic = (requestId: string) => `creation:${requestId}`;

export type LiveMessageType = 'creation.updated' | 'market.updated' | 'liquidity.changed' | 'trade.executed' | 'trade.reverted' | 'snapshot.required';
export type LiveMessage = {
  type: LiveMessageType;
  /** `public`, or `creation:<requestId>` for a message only that request's token holder receives. */
  topic: string;
  payload: Record<string, unknown>;
  blockNumber?: number;
};
/** A message as it left the replay log: what the SSE stream sends, id included. */
export type LiveEventRecord = { id: bigint; type: string; topic: string; payload: unknown; blockNumber: number | null };

/**
 * Appends messages to the replay log and wakes every API process, in the caller's transaction.
 * `pg_notify` inside a transaction is delivered on commit and dropped on rollback, which is the
 * only ordering that never announces a change the database does not hold.
 */
export async function recordLiveEvents(tx: Prisma.TransactionClient, messages: LiveMessage[]): Promise<bigint[]> {
  if (messages.length === 0) return [];
  const ids: bigint[] = [];
  for (const message of messages) {
    const row = await tx.liveEvent.create({
      data: { type: message.type, topic: message.topic, payload: message.payload as Prisma.InputJsonValue, blockNumber: message.blockNumber ?? null },
      select: { id: true },
    });
    ids.push(row.id);
  }
  const payload = JSON.stringify({ upTo: ids[ids.length - 1]!.toString() });
  await tx.$executeRaw`SELECT pg_notify(${LIVE_CHANNEL}, ${payload})`;
  return ids;
}

/** Coalesces one block's worth of messages: one per market per type, whatever the number of fills. */
export class MessageBatch {
  private markets = new Map<string, LiveMessage>();
  private liquidity = new Map<string, LiveMessage>();
  private rest: LiveMessage[] = [];
  constructor(private blockNumber: number, private final: boolean) {}

  marketUpdated(market: string, extra: Record<string, unknown> = {}) {
    const key = market.toLowerCase();
    const previous = this.markets.get(key)?.payload ?? {};
    this.markets.set(key, { type: 'market.updated', topic: PUBLIC_TOPIC, blockNumber: this.blockNumber,
      payload: { ...previous, ...extra, market: key, blockNumber: this.blockNumber, final: this.final } });
  }
  liquidityChanged(market: string) {
    const key = market.toLowerCase();
    if (!this.liquidity.has(key)) this.liquidity.set(key, { type: 'liquidity.changed', topic: PUBLIC_TOPIC, blockNumber: this.blockNumber,
      payload: { market: key, blockNumber: this.blockNumber, final: this.final } });
  }
  push(type: LiveMessageType, topic: string, payload: Record<string, unknown>) {
    this.rest.push({ type, topic, blockNumber: this.blockNumber, payload: { ...payload, blockNumber: this.blockNumber, final: this.final } });
  }
  get size() { return this.markets.size + this.liquidity.size + this.rest.length; }
  /** Private notices first, so a creator's own page updates before the public list re-fetches. */
  drain(): LiveMessage[] { return [...this.rest, ...this.markets.values(), ...this.liquidity.values()]; }
}
