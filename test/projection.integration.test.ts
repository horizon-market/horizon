import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { createDatabase } from '../src/db.js';
import type { ProjectedCurve, ProjectedMarket } from '../src/trading/graph.js';
import { MARKET_CHECKPOINT, MarketProjectionStore, syncMarkets, type MarketSource } from '../src/trading/projection.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);

const hex = (byte: number, length: number) => `0x${byte.toString(16).padStart(2, '0').repeat(length)}` as Hex;
const marketAt = (byte: number, overrides: Partial<ProjectedMarket> = {}): ProjectedMarket => ({
  id: hex(byte, 20) as Address, creationId: hex(byte, 32), question: `Question ${byte}`, rules: 'Rules',
  evidenceSource: 'https://example.test', closeAt: 1_800_000_000, resolver: hex(0xa1, 20) as Address,
  yesToken: hex(0xb2, 20) as Address, noToken: hex(0xc3, 20) as Address, result: 0, resolutionEvidence: '',
  collateral: 1_000_000n, createdAt: 1_700_000_000 + byte, ...overrides,
});
const curveAt = (byte: number, market: ProjectedMarket, overrides: Partial<ProjectedCurve> = {}): ProjectedCurve => ({
  id: hex(byte, 32), market: market.id, maker: hex(0xd4, 20) as Address, flags: 6, startPrice: 400_000,
  endPrice: 200_000, maxShares: 10_000_000n, filled: 0n, salt: hex(byte, 32), active: true,
  publishedAt: 1_700_000_100 + byte, ...overrides,
});

/** A Graph stand-in that pages exactly as the real one does, so the sweep logic is what is tested. */
function fakeGraph(markets: ProjectedMarket[], curves: ProjectedCurve[], block = 100): MarketSource & { marketCalls: number } {
  const page = <T extends { id: string }>(items: T[], after: string, first: number) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id)).filter(item => item.id > after).slice(0, first);
  const source = {
    marketCalls: 0,
    async pageMarkets(after: string, first: number) {
      source.marketCalls++;
      return { block, hash: hex(0xee, 32), markets: page(markets, after, first) };
    },
    async pageStrategies(after: string, first: number) {
      return { block, hash: hex(0xee, 32), curves: page(curves, after, first) };
    },
  };
  return source;
}

async function reset() {
  await db.curveProjection.deleteMany();
  await db.marketProjection.deleteMany();
  await db.syncCheckpoint.deleteMany();
}
test.after(async () => { await reset(); await db.$disconnect(); });

test('a sweep mirrors every market and curve, and pages past the page size', async () => {
  await reset();
  const markets = [marketAt(1), marketAt(2), marketAt(3)];
  const curves = markets.flatMap((market, index) => [curveAt(index * 2 + 1, market), curveAt(index * 2 + 2, market)]);
  const graph = fakeGraph(markets, curves);
  const report = await syncMarkets(db, graph, { pageSize: 2 });

  assert.equal(report.status, 'OK');
  assert.equal(report.markets, 3);
  assert.equal(report.curves, 6);
  // Three markets at two per page needs a second page and a short third to end the sweep.
  assert.equal(graph.marketCalls, 2);
  assert.equal(await db.marketProjection.count(), 3);
  assert.equal(await db.curveProjection.count(), 6);
  const checkpoint = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: MARKET_CHECKPOINT } });
  assert.equal(checkpoint.indexedBlock, 100);
});

test('a second sweep updates mutated rows and removes what the Graph no longer reports', async () => {
  await reset();
  const [first, second] = [marketAt(1), marketAt(2)];
  const kept = curveAt(1, first);
  const cancelled = curveAt(2, first);
  await syncMarkets(db, fakeGraph([first, second], [kept, cancelled]), { pageSize: 50 });

  // A fill, a resolution and a cancellation all mutate rows in place without changing createdAt.
  const resolved = { ...first, result: 1, collateral: 5_000_000n, resolutionEvidence: 'https://example.test/proof' };
  const filled = { ...kept, filled: 4_000_000n, active: false };
  const report = await syncMarkets(db, fakeGraph([resolved], [filled]), { pageSize: 50 });

  assert.equal(report.status, 'OK');
  assert.equal(report.removedMarkets, 1);
  assert.equal(report.removedCurves, 1);
  const row = await db.marketProjection.findUniqueOrThrow({ where: { address: first.id.toLowerCase() } });
  assert.equal(row.result, 1);
  assert.equal(row.collateral, '5000000');
  const curve = await db.curveProjection.findUniqueOrThrow({ where: { id: kept.id.toLowerCase() } });
  assert.equal(curve.filled, '4000000');
  assert.equal(curve.active, false);
  assert.equal(await db.marketProjection.count(), 1);
  assert.equal(await db.curveProjection.count(), 1);
});

test('an empty sweep never wipes a populated mirror', async () => {
  await reset();
  const market = marketAt(1);
  await syncMarkets(db, fakeGraph([market], [curveAt(1, market)]), { pageSize: 50 });
  const good = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: MARKET_CHECKPOINT } });
  const report = await syncMarkets(db, fakeGraph([], []), { pageSize: 50 });

  assert.equal(report.status, 'EMPTY_SNAPSHOT_IGNORED');
  assert.equal(await db.marketProjection.count(), 1);
  const checkpoint = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: MARKET_CHECKPOINT } });
  assert.equal(checkpoint.failureCode, 'empty_snapshot');
  // The rejected sweep records itself but does not advance freshness: the mirror ages from the
  // last sweep that was actually believed, and falls back on its own once past the budget.
  assert.equal(checkpoint.syncedAt.getTime(), good.syncedAt.getTime());
});

test('the store serves fresh mirrors and refuses stale ones', async () => {
  await reset();
  const market = marketAt(1);
  const active = curveAt(1, market);
  const inactive = curveAt(2, market, { active: false });
  await syncMarkets(db, fakeGraph([market], [active, inactive]), { pageSize: 50 });

  const fresh = new MarketProjectionStore(db, 60_000);
  const snapshot = await fresh.indexedMarkets();
  assert.equal(snapshot?.markets.length, 1);
  assert.equal(snapshot?.block, 100);
  // Discovery shows live curves only; a maker still sees their cancelled ones.
  assert.equal(snapshot?.markets[0]?.curves.length, 1);
  assert.equal(snapshot?.markets[0]?.collateral, 1_000_000n);
  const maker = await fresh.curvesByMaker(active.maker);
  assert.equal(maker?.curves.length, 2);
  assert.equal(maker?.curves[0]?.question, market.question);

  const one = await fresh.indexedMarket(market.id);
  assert.equal(one?.markets.length, 1);
  const missing = await fresh.indexedMarket(hex(0x99, 20) as Address);
  assert.equal(missing?.markets.length, 0);

  // Past the staleness budget the store returns nothing, which is what sends reads to The Graph.
  const stale = new MarketProjectionStore(db, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await stale.indexedMarkets(), null);
  assert.equal(await stale.curvesByMaker(active.maker), null);
});

test('a failed sweep leaves the last good mirror in place and does not advance freshness', async () => {
  await reset();
  const market = marketAt(1);
  await syncMarkets(db, fakeGraph([market], [curveAt(1, market)]), { pageSize: 50 });
  const broken: MarketSource = {
    pageMarkets: async () => { throw new Error('graph down'); },
    pageStrategies: async () => ({ block: 0, hash: hex(0, 32), curves: [] }),
  };
  const good = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: MARKET_CHECKPOINT } });
  await assert.rejects(syncMarkets(db, broken, { pageSize: 50 }), /graph down/);

  assert.equal(await db.marketProjection.count(), 1);
  const checkpoint = await db.syncCheckpoint.findUniqueOrThrow({ where: { id: MARKET_CHECKPOINT } });
  assert.equal(checkpoint.status, 'FAILED');
  assert.equal(checkpoint.failureCode, 'sync_failed');
  assert.equal(checkpoint.syncedAt.getTime(), good.syncedAt.getTime());
  // The Graph being down is exactly when falling back to it helps least: keep serving last-good
  // data until it ages out, and only then hand reads back to the indexer.
  assert.equal((await new MarketProjectionStore(db, 60_000).indexedMarkets())?.markets.length, 1);
  assert.equal(await new MarketProjectionStore(db, 0).indexedMarkets(), null);
});
