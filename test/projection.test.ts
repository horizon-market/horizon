import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import type { ProjectedCurve, ProjectedMarket } from '../src/trading/graph.js';
import { fromCurveRow, fromMarketRow, toCurveRow, toMarketRow } from '../src/trading/projection.js';

const market = (overrides: Partial<ProjectedMarket> = {}): ProjectedMarket => ({
  id: '0xBc7C4cc7E0f944053BFa0607592ef4cF215c758e' as Address, creationId: '0xfeed', question: 'Will it?',
  rules: 'Resolves YES when it does.', evidenceSource: 'https://example.test/evidence', closeAt: 1789163904,
  resolver: '0x00000000000000000000000000000000000000A1' as Address,
  yesToken: '0x00000000000000000000000000000000000000B2' as Address,
  noToken: '0x00000000000000000000000000000000000000C3' as Address,
  result: 0, resolutionEvidence: '', collateral: 2_000_000n, createdAt: 1788904716, ...overrides,
});
const curve = (overrides: Partial<ProjectedCurve> = {}): ProjectedCurve => ({
  id: `0x${'a'.repeat(64)}` as Hex, market: market().id, maker: '0x00000000000000000000000000000000000000D4' as Address,
  flags: 6, startPrice: 400_000, endPrice: 200_000, maxShares: 10n ** 15n, filled: 123_456_789n,
  salt: `0x${'b'.repeat(64)}` as Hex, active: true, admitted: true, publishedAt: 1788904800, ...overrides,
});
const syncedAt = new Date('2026-09-09T12:00:00.000Z');

test('a market survives the round trip through storage unchanged', () => {
  const source = market();
  const restored = fromMarketRow(toMarketRow(source, 11_669_085, syncedAt), []);
  // Addresses are lowercased on the way in, which is what the Graph and every caller already use.
  assert.deepEqual(restored, { ...source, id: source.id.toLowerCase(), resolver: source.resolver.toLowerCase(),
    yesToken: source.yesToken.toLowerCase(), noToken: source.noToken.toLowerCase(), curves: [] });
});

test('uint256 amounts and unix timestamps keep their exact values across storage', () => {
  const source = market({ collateral: 2n ** 255n, closeAt: 2_147_483_647, createdAt: 1 });
  const row = toMarketRow(source, 1, syncedAt);
  const restored = fromMarketRow(row, []);
  assert.equal(row.collateral, source.collateral.toString());
  assert.equal(restored.collateral, source.collateral);
  assert.equal(restored.closeAt, 2_147_483_647);
  assert.equal(restored.createdAt, 1);
});

test('a curve keeps its strategy identity, so a mirrored candidate hashes as the Graph one does', () => {
  const source = curve();
  const restored = fromCurveRow(toCurveRow(source, 11_669_085, syncedAt));
  assert.deepEqual(restored.strategy, { market: source.market.toLowerCase(), flags: source.flags,
    startPrice: source.startPrice, endPrice: source.endPrice, maxShares: source.maxShares, salt: source.salt });
  assert.equal(restored.filled, 123_456_789n);
  assert.equal(restored.maker, source.maker.toLowerCase());
});
