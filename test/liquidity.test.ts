import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { buildBook, describeCurves, isLimitOrder, summarize, type ActiveCurve } from '../src/trading/liquidity.js';
import { marginalPrice } from '../src/trading/math.js';
import { averageFillPrice, averageIn, curveOrders, priceAtFilled, priceIn, remainingOf, sampleRemaining, samplesIn,
  separate, type DescribedOrder, type RestingCurve } from '../web/src/curve.js';

const market = '0x0000000000000000000000000000000000000009' as Address;
const maker = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** shape * 4 + buy * 2 + yes, the same packing `src/trading/math.ts` reads. */
const flags = (shape: number, isBuy: boolean, isYes: boolean) => shape * 4 + (isBuy ? 2 : 0) + (isYes ? 1 : 0);

let next = 1;
const resting = (options: {
  shape?: number; isBuy: boolean; isYes: boolean; startPrice: number; endPrice?: number;
  maxShares?: bigint; filled?: bigint;
}): ActiveCurve => ({
  id: id(next++), maker: maker(next),
  filled: options.filled ?? 0n,
  strategy: { market, flags: flags(options.shape ?? 1, options.isBuy, options.isYes),
    startPrice: options.startPrice, endPrice: options.endPrice ?? options.startPrice,
    maxShares: options.maxShares ?? 10_000_000n, salt: id(0) },
});

/* -----------------------------------------------------------------------------
   Order separation
   -------------------------------------------------------------------------- */

test('the ladder carries fixed-price orders only, so curve depth cannot leak into a level', () => {
  const limit = resting({ isBuy: false, isYes: true, startPrice: 600_000, maxShares: 4_000_000n });
  // A curve that happens to be marginally priced at exactly the limit order's price right now.
  const curve = resting({ isBuy: false, isYes: true, startPrice: 600_000, endPrice: 900_000, maxShares: 9_000_000n });
  assert.equal(marginalPrice(curve.strategy, 0n), 600_000);
  assert.equal(isLimitOrder(limit), true);
  assert.equal(isLimitOrder(curve), false);

  const book = buildBook([limit, curve]);
  assert.deepEqual(book.yes.asks, [
    { price: 600_000, shares: 4_000_000n, orders: 1, source: 'direct', executable: true },
  ]);
  // Not 13 shares at 0.60: the curve's nine only start there and are dearer every share after.
  assert.equal(book.yes.asks[0]!.shares, 4_000_000n);
});

test('a curve is kept out of the ladder on both outcomes, restated or not', () => {
  const curve = resting({ isBuy: true, isYes: false, startPrice: 400_000, endPrice: 300_000 });
  const book = buildBook([curve]);
  assert.deepEqual(book.yes, { asks: [], bids: [], spread: null });
  assert.deepEqual(book.no, { asks: [], bids: [], spread: null });
});

test('limit orders keep complementary restatement and the deferred sell-and-merge flag', () => {
  const directAsk = resting({ isBuy: false, isYes: true, startPrice: 620_000, maxShares: 3_000_000n });
  const complementaryAsk = resting({ isBuy: true, isYes: false, startPrice: 390_000, maxShares: 5_000_000n });
  const complementaryBid = resting({ isBuy: false, isYes: false, startPrice: 450_000, maxShares: 7_000_000n });
  const book = buildBook([directAsk, complementaryAsk, complementaryBid]);

  assert.deepEqual(book.yes.asks.map(level => [level.price, level.source, level.executable]), [
    [610_000, 'complementary', true], [620_000, 'direct', true],
  ]);
  // A resting NO sell is a YES bid only through sell-and-merge routing, which is not built yet.
  assert.deepEqual(book.yes.bids.map(level => [level.price, level.executable]), [[550_000, false]]);
  assert.equal(book.yes.spread, null, 'a bid nobody can hit does not make a two-sided market');
});

test('same-price limit orders aggregate, and executable depth never merges with deferred depth', () => {
  const one = resting({ isBuy: false, isYes: true, startPrice: 600_000, maxShares: 2_000_000n });
  const two = resting({ isBuy: false, isYes: true, startPrice: 600_000, maxShares: 3_000_000n });
  const asks = buildBook([one, two]).yes.asks;
  assert.deepEqual(asks, [{ price: 600_000, shares: 5_000_000n, orders: 2, source: 'direct', executable: true }]);

  const bid = resting({ isBuy: true, isYes: true, startPrice: 550_000, maxShares: 1_000_000n });
  const deferred = resting({ isBuy: false, isYes: false, startPrice: 450_000, maxShares: 4_000_000n });
  const bids = buildBook([bid, deferred]).yes.bids;
  assert.deepEqual(bids.map(level => [level.price, level.shares, level.executable]), [
    [550_000, 1_000_000n, true], [550_000, 4_000_000n, false],
  ]);
});

test('exhausted, cancelled and expired orders contribute nothing anywhere', () => {
  // Cancelled and expired orders never reach these functions: the API only passes active ones.
  const spent = resting({ isBuy: false, isYes: true, startPrice: 600_000, maxShares: 5_000_000n, filled: 5_000_000n });
  const overfilled = resting({ isBuy: true, isYes: true, startPrice: 400_000, maxShares: 5_000_000n, filled: 6_000_000n });
  assert.deepEqual(buildBook([spent, overfilled]).yes, { asks: [], bids: [], spread: null });
  assert.deepEqual(describeCurves([spent, overfilled]), []);
  const totals = summarize([spent, overfilled]);
  assert.deepEqual([totals.curves, totals.yes.ask, totals.yes.bid], [0, null, null]);
});

test('the best bid and ask still speak for both limit orders and curves', () => {
  const limit = resting({ isBuy: false, isYes: true, startPrice: 700_000, maxShares: 4_000_000n });
  const curve = resting({ isBuy: false, isYes: true, startPrice: 650_000, endPrice: 800_000, maxShares: 6_000_000n });
  const bid = resting({ isBuy: true, isYes: true, startPrice: 500_000, endPrice: 300_000, maxShares: 5_000_000n });

  const totals = summarize([limit, curve, bid]);
  assert.equal(totals.yes.ask, 650_000, 'the curve is the cheapest offer even though the ladder omits it');
  assert.equal(totals.yes.bid, 500_000);
  assert.equal(totals.yes.availableShares, 10_000_000n);
  assert.equal(totals.curves, 3);
  // The ladder shows only the limit order, so the two views must not be read as the same number.
  assert.deepEqual(buildBook([limit, curve, bid]).yes.asks.map(level => level.price), [700_000]);
});

test('described curves carry the parameters a chart needs, priced at where they stand now', () => {
  const partly = resting({ shape: 2, isBuy: true, isYes: false, startPrice: 400_000, endPrice: 200_000,
    maxShares: 10_000_000n, filled: 5_000_000n });
  const [described] = describeCurves([partly]);
  assert.ok(described);
  assert.equal(described.side, 'NO');
  assert.equal(described.direction, 'BUY');
  assert.equal(described.shape, 2);
  assert.equal(described.isLimit, false);
  assert.equal(described.remaining, 5_000_000n);
  // 400000 + (200000 - 400000) * 0.5^2
  assert.equal(described.price, 350_000);
  assert.equal(described.price, marginalPrice(partly.strategy, partly.filled));
  assert.equal(described.strategy.maxShares, 10_000_000n, 'the published size survives for the chart');
});

/* -----------------------------------------------------------------------------
   Partially filled curve sampling
   -------------------------------------------------------------------------- */

const half: RestingCurve = { isBuy: true, startPrice: 600_000, endPrice: 400_000, shape: 1,
  shares: 10_000_000n, filled: 5_000_000n };

test('sampling a partly filled curve starts where it stands and ends where it runs out', () => {
  assert.equal(remainingOf(half), 5_000_000n);
  const samples = sampleRemaining(half, 4);
  assert.equal(samples.length, 5);
  assert.deepEqual(samples[0], { additional: 0n, price: 500_000 });
  assert.equal(samples[0]!.price, priceAtFilled(half, half.filled), 'the first sample is the price now');
  assert.deepEqual(samples.at(-1), { additional: 5_000_000n, price: 400_000 });
  assert.deepEqual(samples.map(sample => sample.additional), [0n, 1_250_000n, 2_500_000n, 3_750_000n, 5_000_000n]);
  // A buy curve declines, so every step is cheaper than the one before it.
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i]!.price < samples[i - 1]!.price);
});

test('a nearly exhausted curve samples only the tail it has left, not the whole function', () => {
  const tail: RestingCurve = { ...half, filled: 9_000_000n };
  const samples = sampleRemaining(tail, 4);
  assert.equal(samples[0]!.price, 420_000);
  assert.deepEqual(samples.at(-1), { additional: 1_000_000n, price: 400_000 });
  // The share axis measures what is left, never the published size.
  assert.equal(samples.at(-1)!.additional, remainingOf(tail));
  assert.ok(samples.every(sample => sample.additional <= 1_000_000n));
});

test('sampling a spent or fully filled curve yields nothing to draw', () => {
  assert.deepEqual(sampleRemaining({ ...half, filled: 10_000_000n }), []);
  assert.deepEqual(sampleRemaining({ ...half, filled: 12_000_000n }), []);
  assert.equal(averageFillPrice({ ...half, filled: 10_000_000n }, 1_000_000n), undefined);
});

test('the marginal price at a point is not the average price of getting there', () => {
  // Marginal is what one more share costs; average is what the whole quantity costs.
  assert.equal(priceAtFilled(half, half.filled), 500_000);
  assert.equal(priceAtFilled(half, half.filled + 1_000_000n), 480_000);
  assert.equal(averageFillPrice(half, 1_000_000n), 490_000);
  assert.equal(averageFillPrice(half, 5_000_000n), 450_000);
  assert.equal(priceAtFilled(half, 10_000_000n), 400_000);
});

test('a fixed-price order prices the same however much of it is taken', () => {
  const limit: RestingCurve = { isBuy: false, startPrice: 610_000, endPrice: 610_000, shape: 1,
    shares: 8_000_000n, filled: 3_000_000n };
  assert.equal(priceAtFilled(limit, limit.filled), 610_000);
  assert.equal(averageFillPrice(limit, 1_000_000n), 610_000);
  assert.equal(averageFillPrice(limit, 5_000_000n), 610_000);
  assert.deepEqual(sampleRemaining(limit, 2).map(sample => sample.price), [610_000, 610_000, 610_000]);
});

test('an oversized quantity is capped at the capacity that is actually left', () => {
  assert.equal(averageFillPrice(half, 50_000_000n), averageFillPrice(half, 5_000_000n));
  assert.equal(averageFillPrice(half, 0n), undefined);
});

/* -----------------------------------------------------------------------------
   The market page's own split
   -------------------------------------------------------------------------- */

const described = (curve: ActiveCurve): DescribedOrder => {
  const [only] = describeCurves([curve]);
  assert.ok(only);
  return JSON.parse(JSON.stringify(only, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) as DescribedOrder;
};

test('the page splits fixed-price orders from curves before it draws either', () => {
  const limit = described(resting({ isBuy: false, isYes: true, startPrice: 600_000, maxShares: 4_000_000n }));
  const curve = described(resting({ isBuy: false, isYes: true, startPrice: 600_000, endPrice: 900_000, maxShares: 9_000_000n }));
  const split = separate([limit, curve], true);
  assert.deepEqual(split.limits.map(order => order.id), [limit.id]);
  assert.deepEqual(split.curves.map(order => order.id), [curve.id]);
  assert.equal(split.curves[0]!.remaining, 9_000_000n);
});

test('a curve on the other outcome is charted as this outcome at one minus its price', () => {
  const other = described(resting({ isBuy: true, isYes: false, startPrice: 400_000, endPrice: 340_000,
    maxShares: 12_000_000n, filled: 6_000_000n }));
  const [order] = curveOrders([other], true);
  assert.ok(order);
  assert.equal(order.side, 'NO', 'what the maker published is still carried');
  assert.equal(order.direction, 'BUY');
  // Buying NO at 0.37 and selling YES at 0.63 are the same trade, so this reads as SELL YES here.
  assert.equal(order.viewDirection, 'SELL');
  assert.equal(order.book, 'ask');
  assert.equal(order.complementary, true);
  assert.equal(order.executable, true, 'a resting buy of the other outcome is routable today');
  assert.equal(order.price, 630_000, '1 - 0.37');
  assert.equal(priceIn(order, 12_000_000n), 660_000, '1 - 0.34 once it is exhausted');
  assert.deepEqual(samplesIn(order, 2).map(sample => sample.price), [630_000, 645_000, 660_000]);
  // A YES buyer pays one minus the maker's own average, which is what the router charges.
  assert.equal(averageIn(order, 6_000_000n), 1_000_000 - averageFillPrice(order.curve, 6_000_000n)!);
});

test('a resting sell of the other outcome is charted but never called executable', () => {
  const other = described(resting({ isBuy: false, isYes: false, startPrice: 300_000, endPrice: 500_000 }));
  const [order] = curveOrders([other], true);
  assert.ok(order);
  assert.equal(order.book, 'bid');
  assert.equal(order.viewDirection, 'BUY', 'selling NO is buying YES, so it bids for YES here');
  assert.equal(order.complementary, true);
  assert.equal(order.executable, false);
  assert.equal(order.price, 700_000);
});

test('the same curve reads as opposite directions on the two outcomes', () => {
  // The case a trader notices first: flipping the selector turns a BUY YES curve into a SELL NO one.
  const buyYes = described(resting({ isBuy: true, isYes: true, startPrice: 300_000, endPrice: 100_000 }));
  const [onYes] = curveOrders([buyYes], true);
  const [onNo] = curveOrders([buyYes], false);
  assert.ok(onYes && onNo);
  assert.deepEqual([onYes.viewDirection, onYes.book, onYes.complementary, onYes.price], ['BUY', 'bid', false, 300_000]);
  assert.deepEqual([onNo.viewDirection, onNo.book, onNo.complementary, onNo.price], ['SELL', 'ask', true, 700_000]);
  // Both readings describe one order, so they stay mirror images at every quantity.
  assert.equal(onYes.id, onNo.id);
  for (const q of [1_000_000n, 5_000_000n, 10_000_000n]) {
    assert.equal(priceIn(onNo, q), 1_000_000 - priceIn(onYes, q));
    assert.equal(averageIn(onNo, q)!, 1_000_000 - averageIn(onYes, q)!);
  }
});

test('a direct curve is never relabelled: it already reads in the viewed outcome\'s terms', () => {
  const sellYes = described(resting({ isBuy: false, isYes: true, startPrice: 600_000, endPrice: 800_000 }));
  const [order] = curveOrders([sellYes], true);
  assert.ok(order);
  assert.deepEqual([order.direction, order.viewDirection, order.complementary], ['SELL', 'SELL', false]);
});

test('a direct curve keeps its own pricing function, in its own terms', () => {
  const own = described(resting({ shape: 2, isBuy: false, isYes: true, startPrice: 550_000, endPrice: 740_000,
    maxShares: 20_000_000n, filled: 4_000_000n }));
  const [order] = curveOrders([own], true);
  assert.ok(order);
  assert.equal(order.complementary, false);
  assert.equal(order.book, 'ask');
  assert.equal(order.shape, 2);
  assert.equal(order.price, priceAtFilled(order.curve, order.curve.filled));
  assert.equal(order.price, 557_600);
  assert.equal(samplesIn(order).at(-1)!.price, 740_000);
});

test('curve rows are ordered cheapest ask first, then the highest bid', () => {
  const dearAsk = described(resting({ isBuy: false, isYes: true, startPrice: 700_000, endPrice: 800_000 }));
  const cheapAsk = described(resting({ isBuy: false, isYes: true, startPrice: 620_000, endPrice: 900_000 }));
  const bid = described(resting({ isBuy: true, isYes: true, startPrice: 500_000, endPrice: 300_000 }));
  const rows = curveOrders([dearAsk, bid, cheapAsk], true);
  assert.deepEqual(rows.map(order => [order.book, order.price]), [['ask', 620_000], ['ask', 700_000], ['bid', 500_000]]);
});

test('an exhausted curve is dropped from the chart the way it is dropped from the ladder', () => {
  const spent = resting({ isBuy: false, isYes: true, startPrice: 600_000, endPrice: 800_000, filled: 10_000_000n });
  assert.deepEqual(describeCurves([spent]), []);
  assert.deepEqual(curveOrders([], true), []);
});
