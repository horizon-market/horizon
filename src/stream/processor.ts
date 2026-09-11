import type { Prisma, PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import type { ChainEvent } from './events.js';
import { MessageBatch, PUBLIC_TOPIC, recordLiveEvents, type LiveMessage } from '../live/messages.js';
import { creationMessage, presentNotification, upsertCreatedNotification, upsertEventCreatedNotification } from '../live/notifications.js';
import type { CurvePayload, MarketPayload } from '../trading/overlay.js';

export const STREAM_CHECKPOINT = 'horizon_events';

/** One delivered block: its identity, the cursor to resume after it, and what Horizon's contracts emitted in it. */
export type BlockBatch = { number: number; hash: string; timestamp: number; cursor: string; finalBlock: number; events: ChainEvent[] };
export type DecodedCurve = { market: Address; flags: number; startPrice: number; endPrice: number; maxShares: bigint; salt: Hex };
export type ProcessorDependencies = {
  db: PrismaClient;
  /**
   * Decodes Aqua strategy bytes through the router, as the Subgraph mapping does, and returns null
   * for anything the router does not recognise as its own order for this maker and hash.
   */
  decodeCurve?: (strategy: Hex, maker: Address, strategyHash: Hex) => Promise<DecodedCurve | null>;
  now?: () => Date;
};
export type BlockReport = { block: number; events: number; changes: number; trades: number; notifications: number; messages: number; replayed: boolean };
export type UndoReport = { lastValidBlock: number; changes: number; trades: number; notifications: number; messages: number };

type ChangeRow = {
  entity: 'market' | 'curve'; key: string; kind: string; market: string; maker: string | null; payload: MarketPayload | CurvePayload;
  blockNumber: number; blockHash: string; txHash: string; logIndex: number;
};
const changeKey = (row: { txHash: string; logIndex: number; entity: string; key: string }) => `${row.txHash}:${row.logIndex}:${row.entity}:${row.key}`;

/** Every market a maker has executable depth in: a fill anywhere moves the wallet all of them draw on. */
async function marketsOfMaker(tx: Prisma.TransactionClient, maker: string): Promise<string[]> {
  const [mirrored, live] = await Promise.all([
    tx.curveProjection.findMany({ where: { maker, active: true, admitted: true }, select: { marketAddress: true }, distinct: ['marketAddress'] }),
    tx.liveChange.findMany({ where: { maker, entity: 'curve', retiredAt: null }, select: { market: true }, distinct: ['market'] }),
  ]);
  return [...new Set([...mirrored.map(row => row.marketAddress), ...live.map(row => row.market)])];
}

/** The request or child a market was deployed for: by its registry key, or by address for rows that predate the key. */
async function creationOf(tx: Prisma.TransactionClient, creationId: string, market: string) {
  // Addresses written by the receipt path keep the checksum casing the deployer returned.
  const byAddress = { marketAddress: { equals: market, mode: 'insensitive' as const } };
  const request = await tx.creationRequest.findFirst({ where: { OR: [{ creationId }, { ...byAddress, kind: 'SINGLE' }] },
    select: { id: true, question: true, kind: true } });
  if (request && request.kind === 'SINGLE') return { requestId: request.id, question: request.question, position: undefined, eventId: null as string | null };
  const child = await tx.creationChild.findFirst({ where: { OR: [{ creationId }, byAddress] },
    select: { requestId: true, position: true, draft: true, request: { select: { eventId: true, question: true } } } });
  if (!child) return null;
  const draft = child.draft as { question?: unknown } | null;
  const question = typeof draft?.question === 'string' ? draft.question : child.request.question;
  return { requestId: child.requestId, question, position: child.position, eventId: child.request.eventId };
}

/**
 * Whether every selected child of a group now has an address, from either witness — and if so,
 * what the one notice a group gets should say. Membership is read from the request's children,
 * not the event's members, so an outcome deselected before approval never holds the group back.
 */
async function completedEvent(tx: Prisma.TransactionClient, requestId: string, eventId: string) {
  const selected = await tx.creationChild.findMany({ where: { requestId, status: { not: 'SKIPPED' } }, select: { position: true } });
  if (selected.length === 0) return null;
  const placed = await tx.eventMarket.count({ where: { eventId, position: { in: selected.map(child => child.position) }, marketAddress: { not: null } } });
  if (placed < selected.length) return null;
  const event = await tx.marketEvent.findUnique({ where: { id: eventId }, select: { slug: true, title: true } });
  return event && { ...event, markets: selected.length };
}

/**
 * Records one block. Everything — changes, trades, notices, the SSE messages and the cursor — is
 * one transaction, so a crash can only replay the block, and a replay writes nothing new: every
 * row is keyed by what identifies it on chain. The messages are only emitted for rows this
 * delivery actually created, so a redelivered block wakes nobody.
 */
export async function processBlock(deps: ProcessorDependencies, batch: BlockBatch): Promise<BlockReport> {
  const final = batch.number <= batch.finalBlock;
  // Strategy bytes are decoded before the transaction opens: a contract read has no place inside one.
  const decoded = new Map<string, DecodedCurve | null>();
  for (const event of batch.events) {
    if (event.kind !== 'SHIPPED' || !deps.decodeCurve) continue;
    decoded.set(event.data.strategyHash, await deps.decodeCurve(event.data.strategy as Hex, event.data.maker as Address, event.data.strategyHash as Hex));
  }
  return deps.db.$transaction(async tx => {
    const seen = new Set((await tx.liveChange.findMany({ where: { blockNumber: batch.number, blockHash: batch.hash },
      select: { txHash: true, logIndex: true, entity: true, key: true } })).map(changeKey));
    const seenTrades = new Set((await tx.trade.findMany({ where: { blockNumber: batch.number, blockHash: batch.hash }, select: { id: true } })).map(row => row.id));
    const messages = new MessageBatch(batch.number, final);
    let changes = 0, trades = 0, notifications = 0, fresh = 0;
    const write = async (row: ChangeRow) => {
      const { entity, key, ...rest } = row;
      const data = { entity, key, ...rest, payload: rest.payload as Prisma.InputJsonObject, final };
      await tx.liveChange.upsert({ where: { txHash_logIndex_entity_key: { txHash: row.txHash, logIndex: row.logIndex, entity, key } },
        create: data, update: { payload: data.payload, final, retiredAt: null } });
      changes++;
      const isNew = !seen.has(changeKey(row));
      if (isNew) fresh++;
      return isNew;
    };
    const at = (event: ChainEvent) => ({ blockNumber: event.blockNumber, blockHash: event.blockHash, txHash: event.txHash, logIndex: event.logIndex });

    for (const event of batch.events) {
      switch (event.kind) {
        case 'MARKET_CREATED': {
          const { market } = event.data;
          const payload: MarketPayload = { creationId: event.data.creationId, question: event.data.question, rules: event.data.rules,
            evidenceSource: event.data.evidenceSource, closeAt: event.data.closeAt, resolver: event.data.resolver, yesToken: event.data.yesToken,
            noToken: event.data.noToken, result: 0, resolutionEvidence: '', collateral: '0', createdAt: event.blockTimestamp };
          const isNew = await write({ entity: 'market', key: market, kind: event.kind, market, maker: null, payload, ...at(event) });
          const creation = await creationOf(tx, event.data.creationId, market);
          if (creation) {
            const witness = { source: 'stream' as const, blockNumber: event.blockNumber, txHash: event.txHash };
            let announced;
            if (creation.position === undefined) {
              announced = await upsertCreatedNotification(tx, { ...witness, requestId: creation.requestId, marketAddress: market, question: creation.question });
            } else if (creation.eventId) {
              // A group's child address is patched the moment it exists, so the event page follows
              // each market; the creator hears once, when the last selected child is there.
              await tx.eventMarket.updateMany({ where: { eventId: creation.eventId, position: creation.position, marketAddress: null }, data: { marketAddress: market } });
              const completed = await completedEvent(tx, creation.requestId, creation.eventId);
              if (completed) announced = await upsertEventCreatedNotification(tx, { ...witness, requestId: creation.requestId, ...completed });
            }
            if (announced?.created) notifications++;
            if (isNew) messages.push('creation.updated', creationMessage(creation.requestId, {}).topic, { requestId: creation.requestId,
              position: creation.position ?? null, marketAddress: market, ...(announced ? { notification: presentNotification(announced.notification) } : {}) });
          }
          if (isNew) messages.marketUpdated(market, { created: true });
          break;
        }
        case 'CURVE_FILLED': {
          const { market, maker, orderHash } = event.data;
          const payload: CurvePayload = { market, maker, filled: event.data.totalFilled };
          const isNew = await write({ entity: 'curve', key: orderHash, kind: event.kind, market, maker, payload, ...at(event) });
          if (!isNew) break;
          messages.liquidityChanged(market);
          messages.marketUpdated(market);
          for (const other of await marketsOfMaker(tx, maker)) messages.liquidityChanged(other);
          break;
        }
        case 'ROUTE_EXECUTED': {
          const id = `${event.txHash}:${event.logIndex}`;
          const data = { market: event.data.market, taker: event.data.taker, recipient: event.data.recipient, isYes: event.data.isYes, isBuy: event.data.isBuy,
            shares: event.data.shares, usdc: event.data.usdcAmount, fills: Number(event.data.fills), blockNumber: event.blockNumber,
            blockHash: event.blockHash, txHash: event.txHash, final, source: 'stream' };
          await tx.trade.upsert({ where: { id }, create: { id, ...data }, update: { ...data, revertedAt: null } });
          trades++;
          if (seenTrades.has(id)) break;
          fresh++;
          messages.push('trade.executed', PUBLIC_TOPIC, { market: event.data.market, trade: { id, ...data, fills: data.fills, transaction: event.txHash, block: event.blockNumber } });
          break;
        }
        case 'STRATEGY_ADMITTED': {
          const { market, maker, orderHash } = event.data;
          const isNew = await write({ entity: 'curve', key: orderHash, kind: event.kind, market, maker, payload: { market, maker, admitted: true }, ...at(event) });
          if (isNew) { messages.liquidityChanged(market); messages.marketUpdated(market); }
          break;
        }
        case 'SHIPPED': {
          const curve = decoded.get(event.data.strategyHash);
          if (!curve) break;
          const payload: CurvePayload = { market: curve.market.toLowerCase(), maker: event.data.maker, flags: curve.flags, startPrice: curve.startPrice,
            endPrice: curve.endPrice, maxShares: curve.maxShares.toString(), salt: curve.salt.toLowerCase(), filled: '0', active: true, publishedAt: event.blockTimestamp };
          const isNew = await write({ entity: 'curve', key: event.data.strategyHash, kind: event.kind, market: payload.market!, maker: event.data.maker, payload, ...at(event) });
          if (isNew) messages.marketUpdated(payload.market!);
          break;
        }
        case 'DOCKED': {
          // Aqua is shared; the maker who shipped is the only one whose dock retires the order.
          const known = await tx.liveChange.findFirst({ where: { entity: 'curve', key: event.data.strategyHash }, select: { market: true, maker: true } })
            ?? await tx.curveProjection.findUnique({ where: { id: event.data.strategyHash }, select: { marketAddress: true, maker: true } })
              .then(row => row ? { market: row.marketAddress, maker: row.maker } : null);
          if (!known || known.maker !== event.data.maker) break;
          const isNew = await write({ entity: 'curve', key: event.data.strategyHash, kind: event.kind, market: known.market, maker: event.data.maker,
            payload: { active: false }, ...at(event) });
          if (isNew) { messages.liquidityChanged(known.market); messages.marketUpdated(known.market); }
          break;
        }
        case 'COLLATERAL_CHANGED': {
          const { market } = event.data;
          const isNew = await write({ entity: 'market', key: market, kind: event.kind, market, maker: null, payload: { collateral: event.data.collateral }, ...at(event) });
          if (isNew) messages.marketUpdated(market);
          break;
        }
        case 'MARKET_RESOLVED': {
          const { market } = event.data;
          const isNew = await write({ entity: 'market', key: market, kind: event.kind, market, maker: null,
            payload: { result: event.data.result, resolutionEvidence: event.data.evidence }, ...at(event) });
          if (isNew) { messages.marketUpdated(market, { resolved: true }); messages.liquidityChanged(market); }
          break;
        }
      }
    }
    // The server's final height moves with every message; rows at or below it stop being revertible.
    await tx.liveChange.updateMany({ where: { final: false, blockNumber: { lte: batch.finalBlock } }, data: { final: true } });
    await tx.trade.updateMany({ where: { final: false, blockNumber: { lte: batch.finalBlock } }, data: { final: true } });
    const outgoing = fresh > 0 ? messages.drain() : [];
    await recordLiveEvents(tx, outgoing);
    await tx.streamCheckpoint.upsert({ where: { id: STREAM_CHECKPOINT },
      create: { id: STREAM_CHECKPOINT, cursor: batch.cursor, blockNumber: batch.number, blockHash: batch.hash, finalBlock: batch.finalBlock },
      update: { cursor: batch.cursor, blockNumber: batch.number, blockHash: batch.hash, finalBlock: batch.finalBlock } });
    // "Replayed" means rows were written and every one already existed — not that nothing applied.
    return { block: batch.number, events: batch.events.length, changes, trades, notifications, messages: outgoing.length, replayed: changes + trades > 0 && fresh === 0 };
  }, { timeout: 30_000 });
}

/**
 * A reorg: every block above `lastValidBlock` is gone. Changes above it are deleted outright —
 * the chain no longer holds them — trades are kept but marked, and a notice only the stream
 * vouched for goes with its block, while one the deployment receipt also confirmed stays.
 */
export async function undoTo(deps: ProcessorDependencies, lastValid: { number: number; hash: string; cursor: string }): Promise<UndoReport> {
  const now = deps.now?.() ?? new Date();
  return deps.db.$transaction(async tx => {
    const above = { blockNumber: { gt: lastValid.number } };
    const reverted = await tx.liveChange.findMany({ where: above, select: { market: true, kind: true, key: true } });
    const removed = await tx.liveChange.deleteMany({ where: above });
    const trades = await tx.trade.findMany({ where: { ...above, revertedAt: null }, select: { id: true, market: true } });
    await tx.trade.updateMany({ where: { ...above, revertedAt: null }, data: { revertedAt: now } });
    const notices = await tx.notification.findMany({ where: { ...above, sources: { equals: ['stream'] } }, select: { id: true, requestId: true, marketAddress: true } });
    await tx.notification.deleteMany({ where: { id: { in: notices.map(notice => notice.id) } } });
    // A child's address that only the reverted block vouched for is withdrawn; a receipt-confirmed one is not.
    const created = reverted.filter(change => change.kind === 'MARKET_CREATED').map(change => change.key);
    if (created.length) {
      const confirmed = new Set((await tx.creationChild.findMany({ where: { status: 'CREATED', marketAddress: { not: null } }, select: { marketAddress: true } }))
        .map(row => row.marketAddress!.toLowerCase()));
      await tx.eventMarket.updateMany({ where: { marketAddress: { in: created.filter(address => !confirmed.has(address)) } }, data: { marketAddress: null } });
    }
    const messages: LiveMessage[] = [];
    for (const market of new Set([...reverted.map(change => change.market), ...trades.map(trade => trade.market)])) {
      messages.push({ type: 'market.updated', topic: PUBLIC_TOPIC, blockNumber: lastValid.number, payload: { market, blockNumber: lastValid.number, final: false, reverted: true } });
      messages.push({ type: 'liquidity.changed', topic: PUBLIC_TOPIC, blockNumber: lastValid.number, payload: { market, blockNumber: lastValid.number, final: false, reverted: true } });
    }
    for (const trade of trades) messages.push({ type: 'trade.reverted', topic: PUBLIC_TOPIC, blockNumber: lastValid.number, payload: { market: trade.market, id: trade.id, blockNumber: lastValid.number, final: false } });
    for (const notice of notices) messages.push(creationMessage(notice.requestId, { marketAddress: notice.marketAddress, reverted: true, notificationId: notice.id }));
    await tx.liveEvent.deleteMany({ where: above });
    await recordLiveEvents(tx, messages);
    await tx.streamCheckpoint.upsert({ where: { id: STREAM_CHECKPOINT },
      create: { id: STREAM_CHECKPOINT, cursor: lastValid.cursor, blockNumber: lastValid.number, blockHash: lastValid.hash },
      update: { cursor: lastValid.cursor, blockNumber: lastValid.number, blockHash: lastValid.hash } });
    return { lastValidBlock: lastValid.number, changes: removed.count, trades: trades.length, notifications: notices.length, messages: messages.length };
  }, { timeout: 30_000 });
}

/** Housekeeping the consumer runs on a timer: the replay log and retired changes are not history. */
export async function prune(db: PrismaClient, now = new Date()) {
  const [events, changes] = await Promise.all([
    db.liveEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 60 * 60_000) } } }),
    db.liveChange.deleteMany({ where: { retiredAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } } }),
  ]);
  return { events: events.count, changes: changes.count };
}
