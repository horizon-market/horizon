import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import type { IndexedSnapshot, MakerCurve } from '../src/trading/graph.js';
import { fromMarketRow, toMarketRow } from '../src/trading/projection.js';
import { applyMakerOverlay, applyOverlay, routeId, type OverlayChange } from '../src/trading/overlay.js';

const hex = (byte: number, length: number) => `0x${byte.toString(16).padStart(2, '0').repeat(length)}` as Hex;
const MARKET = hex(0x11, 20) as Address, OTHER = hex(0x22, 20) as Address, MAKER = hex(0xd4, 20) as Address;
const ORDER = hex(0xaa, 32), NEW_ORDER = hex(0xbb, 32);

const snapshot = (): IndexedSnapshot => ({ block: 100, hash: hex(0xee, 32), markets: [{
  id: MARKET, creationId: hex(0x01, 32), question: 'Will it?', rules: 'Rules', evidenceSource: 'https://example.test', closeAt: 1_800_000_000,
  resolver: hex(0xa1, 20) as Address, yesToken: hex(0xb2, 20) as Address, noToken: hex(0xc3, 20) as Address, result: 0, resolutionEvidence: '',
  collateral: 1_000_000n, createdAt: 1_700_000_000,
  curves: [{ id: ORDER, maker: MAKER, filled: 1_000_000n, strategy: { market: MARKET, flags: 6, startPrice: 400_000, endPrice: 200_000, maxShares: 10_000_000n, salt: hex(0x5a, 32) } }],
}] });
const change = (overrides: Partial<OverlayChange> & Pick<OverlayChange, 'entity' | 'key' | 'payload'>): OverlayChange => ({
  kind: 'TEST', market: MARKET, maker: null, blockNumber: 101, logIndex: 0, retiredAt: null, ...overrides,
});
const created = (market: Address, block = 101): OverlayChange => change({ entity: 'market', key: market, kind: 'MARKET_CREATED', market, blockNumber: block, payload: {
  creationId: hex(0x02, 32), question: 'New?', rules: 'R', evidenceSource: 'E', closeAt: 1_900_000_000, resolver: hex(0xa1, 20), yesToken: hex(0xb4, 20),
  noToken: hex(0xc5, 20), result: 0, resolutionEvidence: '', collateral: '0', createdAt: 1_700_000_500 } });

test('a market created after the snapshot is listed first, with a Graph-shaped row', () => {
  const result = applyOverlay(snapshot(), [created(OTHER)]);
  assert.equal(result.markets.length, 2);
  assert.equal(result.markets[0]!.id, OTHER);
  assert.equal(result.liveBlock, 101);
  // The added market survives the same storage round trip a Graph market does, unchanged.
  const { curves, ...row } = result.markets[0]!;
  assert.deepEqual(fromMarketRow(toMarketRow(row, 101, new Date()), []), { ...row, curves: [] });
  assert.deepEqual(curves, []);
});

test('changes at or below the snapshot block, and retired ones, never apply', () => {
  const stale = created(OTHER, 100);
  const retired = { ...created(OTHER, 105), retiredAt: new Date() };
  const result = applyOverlay(snapshot(), [stale, retired]);
  assert.equal(result.markets.length, 1);
  assert.equal(result.liveBlock, null);
});

test('a fill patches the curve, and an exhausting fill drops it from executable depth', () => {
  const partial = change({ entity: 'curve', key: ORDER, kind: 'CURVE_FILLED', maker: MAKER, payload: { filled: '4000000' } });
  let result = applyOverlay(snapshot(), [partial]);
  assert.equal(result.markets[0]!.curves[0]!.filled, 4_000_000n);
  const exhausted = change({ entity: 'curve', key: ORDER, kind: 'CURVE_FILLED', maker: MAKER, blockNumber: 102, payload: { filled: '10000000' } });
  result = applyOverlay(snapshot(), [partial, exhausted]);
  assert.deepEqual(result.markets[0]!.curves, []);
  // A cancellation has the same effect, whatever the fill.
  result = applyOverlay(snapshot(), [change({ entity: 'curve', key: ORDER, kind: 'DOCKED', maker: MAKER, payload: { active: false } })]);
  assert.deepEqual(result.markets[0]!.curves, []);
});

test('a shipped curve becomes depth only once it is admitted, and only in its own market', () => {
  const shipped = change({ entity: 'curve', key: NEW_ORDER, kind: 'SHIPPED', maker: MAKER, payload: {
    market: MARKET, maker: MAKER, flags: 5, startPrice: 300_000, endPrice: 300_000, maxShares: '5000000', salt: hex(0x5b, 32), filled: '0', active: true, publishedAt: 1_700_000_600 } });
  assert.equal(applyOverlay(snapshot(), [shipped]).markets[0]!.curves.length, 1);
  const admitted = change({ entity: 'curve', key: NEW_ORDER, kind: 'STRATEGY_ADMITTED', maker: MAKER, blockNumber: 102, payload: { admitted: true } });
  const result = applyOverlay(snapshot(), [shipped, admitted]);
  assert.equal(result.markets[0]!.curves.length, 2);
  const added = result.markets[0]!.curves.find(curve => curve.id === NEW_ORDER)!;
  assert.deepEqual(added.strategy, { market: MARKET, flags: 5, startPrice: 300_000, endPrice: 300_000, maxShares: 5_000_000n, salt: hex(0x5b, 32) });
  // Order of arrival does not matter: the admission before the shipment reads the same.
  assert.equal(applyOverlay(snapshot(), [{ ...admitted, blockNumber: 101, logIndex: 0 }, { ...shipped, blockNumber: 101, logIndex: 1 }]).markets[0]!.curves.length, 2);
});

test('resolution and collateral patches reach the market row', () => {
  const result = applyOverlay(snapshot(), [
    change({ entity: 'market', key: MARKET, kind: 'COLLATERAL_CHANGED', payload: { collateral: '2500000' } }),
    change({ entity: 'market', key: MARKET, kind: 'MARKET_RESOLVED', blockNumber: 102, payload: { result: 1, resolutionEvidence: 'https://example.test/proof' } }),
  ]);
  assert.equal(result.markets[0]!.collateral, 2_500_000n);
  assert.equal(result.markets[0]!.result, 1);
  assert.equal(result.markets[0]!.resolutionEvidence, 'https://example.test/proof');
});

test('a scoped read ignores markets created elsewhere', () => {
  const result = applyOverlay(snapshot(), [created(OTHER)], { market: MARKET });
  assert.equal(result.markets.length, 1);
});

test("a maker's list patches known curves and describes new ones only with their market", () => {
  const base: { block: number; hash: Hex; curves: MakerCurve[] } = { block: 100, hash: hex(0xee, 32), curves: [{
    id: ORDER, maker: MAKER, market: MARKET, question: 'Will it?', flags: 6, startPrice: 400_000, endPrice: 200_000, maxShares: 10_000_000n,
    filled: 0n, active: true, admitted: true, publishedAt: 1_700_000_000, salt: hex(0x5a, 32), closeAt: 1_800_000_000, result: 0,
    yesToken: hex(0xb2, 20) as Address, noToken: hex(0xc3, 20) as Address }] };
  const fill = change({ entity: 'curve', key: ORDER, kind: 'CURVE_FILLED', maker: MAKER, payload: { filled: '2000000' } });
  const shipped = change({ entity: 'curve', key: NEW_ORDER, kind: 'SHIPPED', maker: MAKER, market: OTHER, payload: {
    market: OTHER, maker: MAKER, flags: 5, startPrice: 300_000, endPrice: 300_000, maxShares: '5000000', salt: hex(0x5b, 32), filled: '0', active: true, publishedAt: 1_700_000_700 } });
  const without = applyMakerOverlay(base, [fill, shipped], MAKER, new Map());
  assert.equal(without.curves.length, 1);
  assert.equal(without.curves[0]!.filled, 2_000_000n);
  const refs = new Map([[OTHER, { question: 'Other?', closeAt: 1_900_000_000, result: 0, yesToken: hex(0xb4, 20) as Address, noToken: hex(0xc5, 20) as Address }]]);
  const withRef = applyMakerOverlay(base, [fill, shipped], MAKER, refs);
  assert.equal(withRef.curves.length, 2);
  assert.equal(withRef.curves[0]!.id, NEW_ORDER);
  assert.equal(withRef.curves[0]!.question, 'Other?');
  assert.equal(withRef.curves[0]!.admitted, false);
});

test('a stream trade carries the same id the Subgraph gives the route', () => {
  // graph-ts `Bytes.concatI32` appends the log index as four little-endian bytes.
  assert.equal(routeId(hex(0xab, 32), 7), `${hex(0xab, 32)}07000000`);
  assert.equal(routeId(hex(0xab, 32), 258), `${hex(0xab, 32)}02010000`);
});
