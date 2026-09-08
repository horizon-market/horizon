import { marginalPrice, isBuy, isYes, type Curve } from './math.js';

export type ActiveCurve = { id: string; maker: string; strategy: Curve; filled: bigint };
export type Side = { ask: number | null; bid: number | null; availableShares: bigint };
export type MarketLiquidity = { yes: Side; no: Side; curves: number };

const remaining = (curve: ActiveCurve) => {
  const left = curve.strategy.maxShares - curve.filled;
  return left > 0n ? left : 0n;
};

/**
 * Indexed display liquidity. Buying an outcome can use a SELL curve for that outcome or a BUY
 * curve for the opposite outcome, because complementary minting delivers the same token.
 * These figures come from The Graph and are discovery only: execution requires an RPC refresh
 * and a full simulation, which the quote service performs.
 */
export function summarize(curves: ActiveCurve[]): MarketLiquidity {
  const sides = { yes: { ask: null as number | null, bid: null as number | null, availableShares: 0n },
    no: { ask: null as number | null, bid: null as number | null, availableShares: 0n } };
  for (const curve of curves) {
    if (remaining(curve) === 0n) continue;
    const price = marginalPrice(curve.strategy, curve.filled);
    const yes = isYes(curve.strategy);
    if (isBuy(curve.strategy)) {
      // A resting buyer bids for its own outcome and funds complementary minting of the other one.
      const own = yes ? sides.yes : sides.no, other = yes ? sides.no : sides.yes;
      own.bid = own.bid === null || price > own.bid ? price : own.bid;
      const complementary = 1_000_000 - price;
      other.ask = other.ask === null || complementary < other.ask ? complementary : other.ask;
      other.availableShares += remaining(curve);
    } else {
      const own = yes ? sides.yes : sides.no;
      own.ask = own.ask === null || price < own.ask ? price : own.ask;
      own.availableShares += remaining(curve);
    }
  }
  return { ...sides, curves: curves.filter(curve => remaining(curve) > 0n).length };
}
