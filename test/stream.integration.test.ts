import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { createDatabase } from '../src/db.js';
import { creationId } from '../src/creation/onchain.js';
import { processBlock, undoTo, STREAM_CHECKPOINT, type BlockBatch } from '../src/stream/processor.js';
import type { ChainEvent } from '../src/stream/events.js';
import { eventNotificationKey, upsertCreatedNotification, upsertEventCreatedNotification } from '../src/live/notifications.js';
import { creationTopic } from '../src/live/messages.js';
import { applyOverlay, LiveStore } from '../src/trading/overlay.js';
import { MarketProjectionStore, syncMarkets, type MarketSource } from '../src/trading/projection.js';
import type { ProjectedCurve, ProjectedMarket } from '../src/trading/graph.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);

const hex = (byte: number, length: number) => `0x${byte.toString(16).padStart(2, '0').repeat(length)}` as Hex;
const MARKET = hex(0x11, 20), OTHER = hex(0x22, 20), MAKER = hex(0xd4, 20), TAKER = hex(0x33, 20), ORDER = hex(0xaa, 32), ORDER_B = hex(0xab, 32);
const at = (block: number, logIndex: number, txByte = 0xf0) => ({
  contract: hex(0x2b, 20), blockNumber: block, blockHash: hex(block % 256, 32), blockTimestamp: 1_789_000_000 + block, txHash: hex(txByte, 32), logIndex, txIndex: 0,
});
const createdEvent = (block: number, market: Hex, creation: Hex, question = 'Will it?'): ChainEvent => ({ ...at(block, 0), kind: 'MARKET_CREATED', data: {
  creationId: creation, market, resolver: hex(0xa1, 20), yesToken: hex(0xb2, 20), noToken: hex(0xc3, 20), closeAt: 1_800_000_000, question, rules: 'R', evidenceSource: 'E' } });
const fillEvent = (block: number, logIndex: number, orderHash: Hex, totalFilled: string, market = MARKET): ChainEvent => ({ ...at(block, logIndex), kind: 'CURVE_FILLED', data: {
  orderHash, market, maker: MAKER, shares: '1000000', usdcAmount: '450000', totalFilled } });
const routeEvent = (block: number, logIndex: number, market = MARKET): ChainEvent => ({ ...at(block, logIndex), kind: 'ROUTE_EXECUTED', data: {
  market, taker: TAKER, recipient: TAKER, isYes: true, isBuy: true, shares: '2000000', usdcAmount: '900000', fills: '2' } });
const batch = (block: number, events: ChainEvent[], finalBlock = block - 64): BlockBatch =>
  ({ number: block, hash: hex(block % 256, 32), timestamp: 1_789_000_000 + block, cursor: `cursor-${block}`, finalBlock, events });

async function reset() {
  await db.liveEvent.deleteMany(); await db.liveChange.deleteMany(); await db.trade.deleteMany(); await db.notification.deleteMany();
  await db.streamCheckpoint.deleteMany(); await db.creationRequest.deleteMany(); await db.marketEvent.deleteMany();
  await db.curveProjection.deleteMany(); await db.marketProjection.deleteMany(); await db.syncCheckpoint.deleteMany();
}
test.after(async () => { await reset(); await db.$disconnect(); });

/** A paid single request mid-creation, exactly as `runCreation` leaves it before the broadcast. */
async function creatingRequest(question = 'Will it?') {
  const id = randomUUID();
  await db.creationRequest.create({ data: { id, idempotencyKey: randomUUID(), question, requesterKind: 'browser', status: 'CREATING', creationId: creationId(id) } });
  return id;
}

test('a block is one transaction: a failure after the trade write leaves nothing behind, cursor included', async () => {
  await reset();
  // The same client, except that the checkpoint write — the last write of the block — fails.
  const broken = { $transaction: (run: (tx: unknown) => Promise<unknown>, options?: unknown) => db.$transaction(tx => run(new Proxy(tx, {
    get: (target, property) => property === 'streamCheckpoint' ? { upsert: () => { throw new Error('disk full'); } } : Reflect.get(target, property),
  })), options as never) } as unknown as PrismaClient;
  const request = await creatingRequest();
  await assert.rejects(processBlock({ db: broken }, batch(200, [createdEvent(200, MARKET, creationId(request)), fillEvent(200, 1, ORDER, '5000000'), routeEvent(200, 2)])), /disk full/);
  assert.equal(await db.liveChange.count(), 0);
  assert.equal(await db.trade.count(), 0);
  assert.equal(await db.notification.count(), 0);
  assert.equal(await db.liveEvent.count(), 0);
  assert.equal(await db.streamCheckpoint.count(), 0);
});

test('a redelivered block creates no rows, no notice and no messages; the cursor still advances', async () => {
  await reset();
  const request = await creatingRequest();
  const events = [createdEvent(201, MARKET, creationId(request)), fillEvent(201, 1, ORDER, '5000000'), fillEvent(201, 2, ORDER, '6000000'), routeEvent(201, 3)];
  const first = await processBlock({ db }, batch(201, events));
  assert.equal(first.replayed, false);
  assert.equal(first.notifications, 1);
  const counts = async () => [await db.liveChange.count(), await db.trade.count(), await db.notification.count(), await db.liveEvent.count()];
  const before = await counts();
  assert.deepEqual(before, [3, 1, 1, before[3]]);
  assert.ok(before[3]! > 0);
  // Two fills of one order in one block are two changes, one liquidity message, one market message.
  const types = (await db.liveEvent.findMany()).map(row => row.type).sort();
  assert.deepEqual(types, ['creation.updated', 'liquidity.changed', 'market.updated', 'trade.executed']);

  const again = await processBlock({ db }, { ...batch(201, events), cursor: 'cursor-201-again' });
  assert.equal(again.replayed, true);
  assert.equal(again.messages, 0);
  assert.deepEqual(await counts(), before);
  const checkpoint = await db.streamCheckpoint.findUniqueOrThrow({ where: { id: STREAM_CHECKPOINT } });
  assert.equal(checkpoint.cursor, 'cursor-201-again');
  assert.equal(checkpoint.blockNumber, 201);
});

test('the stored cursor is what a restart resumes from, and an undo moves it back', async () => {
  await reset();
  await processBlock({ db }, batch(300, [routeEvent(300, 0)]));
  await processBlock({ db }, batch(301, [routeEvent(301, 0, OTHER)], 250));
  assert.equal((await db.streamCheckpoint.findUniqueOrThrow({ where: { id: STREAM_CHECKPOINT } })).cursor, 'cursor-301');
  await undoTo({ db }, { number: 300, hash: hex(300 % 256, 32), cursor: 'cursor-300-valid' });
  const checkpoint = await db.streamCheckpoint.findUniqueOrThrow({ where: { id: STREAM_CHECKPOINT } });
  assert.equal(checkpoint.cursor, 'cursor-300-valid');
  assert.equal(checkpoint.blockNumber, 300);
});

test('a reorg deletes changes above the last valid block, marks trades, and keeps receipt-backed notices', async () => {
  await reset();
  const receiptOnly = await creatingRequest('Confirmed by receipt');
  const streamOnly = await creatingRequest('Seen on the stream');
  await db.$transaction(tx => upsertCreatedNotification(tx, { requestId: receiptOnly, marketAddress: MARKET, question: 'Confirmed by receipt', source: 'receipt', txHash: null }));
  await processBlock({ db }, batch(400, [createdEvent(400, MARKET, creationId(receiptOnly), 'Confirmed by receipt'), fillEvent(400, 1, ORDER, '1000000')]));
  await processBlock({ db }, batch(401, [createdEvent(401, OTHER, creationId(streamOnly), 'Seen on the stream'), routeEvent(401, 1, OTHER), fillEvent(401, 2, ORDER_B, '2000000', OTHER)]));
  const merged = await db.notification.findFirstOrThrow({ where: { requestId: receiptOnly } });
  assert.deepEqual(merged.sources, ['receipt', 'stream']);
  assert.equal(await db.notification.count(), 2);

  const lastBefore = (await db.liveEvent.findFirstOrThrow({ orderBy: { id: 'desc' } })).id;
  const report = await undoTo({ db }, { number: 400, hash: hex(400 % 256, 32), cursor: 'cursor-400' });
  assert.equal(report.changes, 2);
  assert.equal(report.trades, 1);
  assert.equal(report.notifications, 1);
  assert.deepEqual((await db.liveChange.findMany()).map(row => row.blockNumber), [400, 400]);
  const trade = await db.trade.findFirstOrThrow();
  assert.ok(trade.revertedAt);
  // The receipt-confirmed notice stays, still marked as seen by both; the stream-only one is gone.
  assert.equal(await db.notification.count(), 1);
  assert.equal((await db.notification.findFirstOrThrow()).requestId, receiptOnly);
  // Block 401's own messages are gone from the replay log; the undo's corrections replace them.
  assert.equal(await db.liveEvent.count({ where: { blockNumber: 401 } }), 0);
  const messages = (await db.liveEvent.findMany({ where: { id: { gt: lastBefore } } })).map(row => row.type).sort();
  assert.deepEqual(messages, ['creation.updated', 'liquidity.changed', 'market.updated', 'trade.reverted']);
  // A reverted trade never reaches history.
  assert.deepEqual(await new LiveStore(db).trades(OTHER, 0), []);
});

test('receipt first or stream first, one notice with both sources; a group is announced once, when its last child exists', async () => {
  await reset();
  const single = await creatingRequest('Single');
  await db.$transaction(tx => upsertCreatedNotification(tx, { requestId: single, marketAddress: MARKET, question: 'Single', source: 'receipt', txHash: hex(0x01, 32) }));
  await processBlock({ db }, batch(500, [createdEvent(500, MARKET, creationId(single), 'Single')]));
  const one = await db.notification.findMany({ where: { requestId: single } });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0]!.sources, ['receipt', 'stream']);
  assert.equal(one[0]!.txHash, hex(0x01, 32));

  // A group of two selected children and one deselected: the stream sees child 1 before the
  // receipt path records it. Its address is patched at once; the creator is not told yet.
  const group = randomUUID();
  const event = await db.marketEvent.create({ data: { slug: `g-${group.slice(0, 8)}`, title: 'Group', members: { create: [
    { position: 0, outcomeLabel: 'A', question: 'A?' }, { position: 1, outcomeLabel: 'B', question: 'B?' } ] } } });
  await db.creationRequest.create({ data: { id: group, idempotencyKey: randomUUID(), question: 'Group', requesterKind: 'browser', status: 'CREATING', kind: 'GROUP', eventId: event.id,
    children: { create: [
      { position: 0, outcomeLabel: 'A', draft: { question: 'A?' }, draftHash: 'a', status: 'CREATING', creationId: creationId(group, 0) },
      { position: 1, outcomeLabel: 'B', draft: { question: 'B?' }, draftHash: 'b', status: 'PENDING', creationId: creationId(group, 1) },
      { position: 2, outcomeLabel: 'C', draft: { question: 'C?' }, draftHash: 'c', status: 'SKIPPED' } ] } } });
  const first = await processBlock({ db }, batch(501, [createdEvent(501, OTHER, creationId(group, 1), 'B?')]));
  assert.equal(first.notifications, 0);
  assert.equal(await db.notification.count({ where: { requestId: group } }), 0);
  const member = await db.eventMarket.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
  assert.equal(member.marketAddress, OTHER);
  // The child still reaches the creator's open tab, so the create page follows it — without a notice.
  const childMessage = await db.liveEvent.findFirstOrThrow({ where: { type: 'creation.updated', topic: creationTopic(group) }, orderBy: { id: 'desc' } });
  assert.equal((childMessage.payload as { position: number }).position, 1);
  assert.equal((childMessage.payload as { notification?: unknown }).notification, undefined);
  // The last selected child completes the event: one notice, for the event, with the block that completed it.
  const THIRD = hex(0x55, 20);
  const second = await processBlock({ db }, batch(502, [createdEvent(502, THIRD, creationId(group, 0), 'A?')]));
  assert.equal(second.notifications, 1);
  const notice = await db.notification.findFirstOrThrow({ where: { requestId: group } });
  assert.equal(notice.dedupeKey, eventNotificationKey(group));
  assert.equal(notice.kind, 'event.created');
  assert.equal(notice.title, 'Your event was created');
  assert.equal(notice.body, 'Group · 2 markets');
  assert.equal(notice.href, `/events/${event.slug}`);
  assert.equal(notice.position, null);
  assert.equal(notice.blockNumber, 502);
  assert.deepEqual(notice.sources, ['stream']);
  const eventMessage = await db.liveEvent.findFirstOrThrow({ where: { type: 'creation.updated', topic: creationTopic(group) }, orderBy: { id: 'desc' } });
  assert.equal((eventMessage.payload as { notification: { id: string } }).notification.id, notice.id);
  // The receipt path, arriving second, merges into the same notice.
  await db.$transaction(tx => upsertEventCreatedNotification(tx, { requestId: group, slug: event.slug, title: 'Group', markets: 2, source: 'receipt', txHash: null }));
  assert.equal(await db.notification.count({ where: { requestId: group } }), 1);
  assert.deepEqual((await db.notification.findFirstOrThrow({ where: { requestId: group } })).sources, ['stream', 'receipt']);
  // A reorg below the completing block withdraws the notice the stream alone vouched for — and the address.
  const alone = randomUUID();
  const aloneEvent = await db.marketEvent.create({ data: { slug: `g-${alone.slice(0, 8)}`, title: 'Alone', members: { create: [{ position: 0, outcomeLabel: 'A', question: 'A?' }] } } });
  await db.creationRequest.create({ data: { id: alone, idempotencyKey: randomUUID(), question: 'Alone', requesterKind: 'browser', status: 'CREATING', kind: 'GROUP', eventId: aloneEvent.id,
    children: { create: [{ position: 0, outcomeLabel: 'A', draft: { question: 'A?' }, draftHash: 'a', status: 'CREATING', creationId: creationId(alone, 0) }] } } });
  await processBlock({ db }, batch(503, [createdEvent(503, hex(0x66, 20), creationId(alone, 0), 'A?')]));
  assert.equal((await db.notification.findFirstOrThrow({ where: { requestId: alone } })).body, 'Alone · 1 market');
  const undone = await undoTo({ db }, { number: 502, hash: hex(502 % 256, 32), cursor: 'cursor-502' });
  assert.equal(undone.notifications, 1);
  assert.equal(await db.notification.count({ where: { requestId: alone } }), 0);
  assert.equal(await db.notification.count({ where: { requestId: group } }), 1);
  assert.equal((await db.eventMarket.findFirstOrThrow({ where: { eventId: aloneEvent.id, position: 0 } })).marketAddress, null);
  // A request that predates the stored key is still found, by the address the receipt recorded.
  const legacy = randomUUID();
  await db.creationRequest.create({ data: { id: legacy, idempotencyKey: randomUUID(), question: 'Legacy', requesterKind: 'browser', status: 'CREATED', marketAddress: hex(0x44, 20).toUpperCase().replace('0X', '0x') } });
  await processBlock({ db }, batch(502, [createdEvent(502, hex(0x44, 20), hex(0x99, 32), 'Legacy')]));
  assert.equal(await db.notification.count({ where: { requestId: legacy } }), 1);
});

const projected = (byte: number, overrides: Partial<ProjectedMarket> = {}): ProjectedMarket => ({
  id: hex(byte, 20) as Address, creationId: hex(byte, 32), question: `Question ${byte}`, rules: 'Rules', evidenceSource: 'https://example.test',
  closeAt: 1_800_000_000, resolver: hex(0xa1, 20) as Address, yesToken: hex(0xb2, 20) as Address, noToken: hex(0xc3, 20) as Address,
  result: 0, resolutionEvidence: '', collateral: 1_000_000n, createdAt: 1_700_000_000 + byte, ...overrides,
});
const projectedCurve = (id: Hex, market: ProjectedMarket, overrides: Partial<ProjectedCurve> = {}): ProjectedCurve => ({
  id, market: market.id, maker: MAKER as Address, flags: 6, startPrice: 400_000, endPrice: 200_000, maxShares: 10_000_000n, filled: 0n,
  salt: hex(0x5a, 32), active: true, admitted: true, publishedAt: 1_700_000_100, ...overrides,
});
const graphAt = (block: number, markets: ProjectedMarket[], curves: ProjectedCurve[]): MarketSource => ({
  async pageMarkets(after, first) { return { block, hash: hex(0xee, 32), markets: markets.filter(m => m.id > after).slice(0, first) }; },
  async pageStrategies(after, first) { return { block, hash: hex(0xee, 32), curves: curves.filter(c => c.id > after).slice(0, first) }; },
});

test('a lagging sweep never removes a live market from reads, and a sweep past its block retires the change without changing the read', async () => {
  await reset();
  const known = projected(0x11);
  const curve = projectedCurve(ORDER, known);
  const store = new MarketProjectionStore(db, 120_000);
  const live = new LiveStore(db);
  const read = async () => {
    const snapshot = (await store.indexedMarkets())!;
    return applyOverlay(snapshot, await live.changes(snapshot.block));
  };
  // Sweep at block 600; then the stream sees a new market and a fill at 605.
  await syncMarkets(db, graphAt(600, [known], [curve]));
  const request = await creatingRequest('New?');
  await processBlock({ db }, batch(605, [createdEvent(605, OTHER, creationId(request), 'New?'), fillEvent(605, 1, ORDER, '4000000')]));
  const fresh = await read();
  assert.deepEqual(fresh.markets.map(market => market.id), [OTHER, MARKET]);
  assert.equal(fresh.markets[1]!.curves[0]!.filled, 4_000_000n);
  assert.equal(fresh.liveBlock, 605);

  // The Subgraph is still behind: another sweep at 602 knows nothing of block 605.
  const lagging = await syncMarkets(db, graphAt(602, [known], [curve]));
  assert.equal(lagging.retiredChanges, 0);
  assert.equal(await db.marketProjection.count(), 1);
  const stillLive = await read();
  assert.deepEqual(stillLive.markets.map(market => market.id), [OTHER, MARKET]);
  assert.equal(stillLive.markets[1]!.curves[0]!.filled, 4_000_000n);

  // The Subgraph catches up: the sweep at 610 carries the market and the fill itself.
  const created = projected(0x22, { question: 'New?', creationId: creationId(request), createdAt: 1_789_000_000 + 605, collateral: 0n });
  const caughtUp = await syncMarkets(db, graphAt(610, [known, created], [{ ...curve, filled: 4_000_000n }]));
  assert.equal(caughtUp.retiredChanges, 2);
  assert.equal(await db.liveChange.count({ where: { retiredAt: null } }), 0);
  const settled = await read();
  assert.equal(settled.liveBlock, null);
  assert.deepEqual(settled.markets.map(market => market.id), stillLive.markets.map(market => market.id));
  assert.equal(settled.markets[1]!.curves[0]!.filled, 4_000_000n);
  assert.equal(settled.markets[0]!.question, 'New?');
});

test('recorded Sepolia blocks replay end to end: markets, one trade per route, and a fill that changes depth', async () => {
  await reset();
  const { readFile } = await import('node:fs/promises');
  const { decodeEvents } = await import('../src/stream/events.js');
  type Fixture = { blocks: { number: number; hash: string; timestamp: number; output: unknown }[] };
  const load = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/substreams/${name}.json`, import.meta.url), 'utf8')) as Fixture;
  for (const fixture of [await load('sepolia-phase2'), await load('sepolia')]) {
    for (const block of fixture.blocks) {
      const { events } = decodeEvents(block.output);
      await processBlock({ db }, { number: block.number, hash: block.hash, timestamp: block.timestamp, cursor: `c-${block.number}`, finalBlock: block.number - 64, events });
    }
  }
  assert.equal(await db.trade.count(), 1);
  const trade = await db.trade.findFirstOrThrow();
  assert.equal(trade.fills, 2);
  assert.equal(trade.source, 'stream');
  // Five markets were created across the two recordings; every one is readable from an empty snapshot.
  const markets = await db.liveChange.count({ where: { entity: 'market', kind: 'MARKET_CREATED' } });
  assert.equal(markets, 5);
  const empty = { block: 0, hash: hex(0, 32), markets: [] };
  const read = applyOverlay(empty, await new LiveStore(db).changes(0));
  assert.equal(read.markets.length, 5);
  const traded = read.markets.find(market => market.id === trade.market)!;
  assert.ok(traded, 'the traded market is readable');
  // The two fills and the collateral changes reached the market row; the fills are not trades.
  assert.ok(traded.collateral > 0n);
  const fills = await db.liveChange.count({ where: { kind: 'CURVE_FILLED' } });
  assert.equal(fills, 2);
  assert.deepEqual((await new LiveStore(db).trades(trade.market, 0)).map(row => row.transaction), [trade.txHash]);
});
