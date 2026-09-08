import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, type Curve } from '../src/trading/math.js';
import { allocate, type Candidate } from '../src/trading/allocator.js';
const address = '0x0000000000000000000000000000000000000001';
const zeroHash = `0x${'0'.repeat(64)}` as const;
const curve: Curve = { market: address, flags: 6, startPrice: 400000, endPrice: 200000, maxShares: 10_000_000n, salt: zeroHash };
const candidate = (id: number, available = 4_000_000n): Candidate => ({ id: `0x${id.toString(16).padStart(64, '0')}`, maker: address, strategy: { ...curve, endPrice: 400000 }, filled: 0n, allocation: 4_000_000n, walletAvailable: available, outputToken: address });
test('curve presets match exact integral examples and flat endpoints', () => {
  assert.equal(cumulative(curve, 10_000_000n), 3_000_000n);
  assert.equal(cumulative({ ...curve, flags: 10 }, 10_000_000n), 3_333_333n);
  assert.equal(cumulative({ ...curve, flags: 14 }, 10_000_000n), 3_500_000n);
  for (const flags of [4, 8, 12, 6, 10, 14]) {
    const s = { ...curve, flags, startPrice: 400000, endPrice: 400000 };
    assert.equal(cumulative(s, 1_000_000n), 400000n);
  }
});
test('allocator aggregates repeated curve chunks into at most four fills', () => {
  const a = candidate(1); a.strategy.maxShares = 1_000_000n;
  const b = candidate(2); b.strategy.maxShares = 1_000_000n;
  const route = allocate([a, b], 2_000_000n, true);
  assert.equal(route.fills.length, 2); assert.equal(route.usdc, 1_200_000n);
  assert.equal(route.fills.reduce((q, f) => q + f.shares, 0n), 2_000_000n);
});
test('shared maker USDC is counted once even with two independent allocations', () => {
  assert.throws(() => allocate([candidate(1, 400000n), candidate(2, 400000n)], 2_000_000n, true), /insufficient/);
});
test('direct sell and complementary curves compete on the taker cost', () => {
  const sell = candidate(1); sell.strategy = { ...curve, flags: 5, startPrice: 300000, endPrice: 300000 };
  const route = allocate([sell, candidate(2)], 1_000_000n, true);
  assert.equal(route.usdc, 300000n); assert.equal(route.fills[0]!.candidate.id, sell.id);
});
test('invalid curve directions and overflowing sizes fail before quoting', () => {
  assert.throws(() => cumulative({ ...curve, maxShares: 10n ** 15n + 1n }, 1n));
  assert.throws(() => cumulative({ ...curve, endPrice: 500000 }, 1n));
  assert.throws(() => cumulative({ ...curve, flags: 2 }, 1n));
});
test('prices near zero and one use representable aggregate fills instead of rejecting small chunks', () => {
  for (const price of [1, 999999]) {
    const c = candidate(1); c.strategy.startPrice = price; c.strategy.endPrice = price;
    const result = allocate([c], 1_000_001n, true);
    assert.equal(result.usdc, 1_000_001n - 1_000_001n * BigInt(price) / 1_000_000n);
    assert.equal(result.fills.length, 1);
  }
});
