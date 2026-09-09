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

export type BookLevel = { price: number; shares: bigint; orders: number; source: 'direct' | 'complementary' | 'mixed'; executable: boolean };
export type OutcomeBook = { asks: BookLevel[]; bids: BookLevel[]; spread: number | null };
export type MarketBook = { yes: OutcomeBook; no: OutcomeBook };

type Entry = { book: 'asks' | 'bids'; price: number; shares: bigint; source: 'direct' | 'complementary'; executable: boolean };

/**
 * One outcome's book, with the other outcome's orders restated in this outcome's terms at
 * `1 - price`, the way a binary venue presents a single ladder.
 *
 * The two complementary directions are not equally executable here:
 *
 * - A resting BUY of the other outcome is an ASK for this one. A buyer's contribution plus the
 *   maker's mints a fully backed pair, and `RouteExecutor` routes exactly that today.
 * - A resting SELL of the other outcome is a BID for this one only if a holder can buy the
 *   complement and merge the pair back into USDC. Sell-and-merge routing is deferred, so those
 *   levels are carried with `executable: false` instead of being presented as fillable depth.
 */
function entriesFor(curve: ActiveCurve, wantYes: boolean): Entry | undefined {
  const left = curve.strategy.maxShares - curve.filled;
  if (left <= 0n) return undefined;
  const price = marginalPrice(curve.strategy, curve.filled);
  const buying = isBuy(curve.strategy);
  if (isYes(curve.strategy) === wantYes) {
    return { book: buying ? 'bids' : 'asks', price, shares: left, source: 'direct', executable: true };
  }
  return buying
    ? { book: 'asks', price: 1_000_000 - price, shares: left, source: 'complementary', executable: true }
    : { book: 'bids', price: 1_000_000 - price, shares: left, source: 'complementary', executable: false };
}

function ladder(entries: Entry[], book: 'asks' | 'bids'): BookLevel[] {
  const levels = new Map<string, BookLevel>();
  for (const entry of entries.filter(item => item.book === book)) {
    // Executable and deferred depth never merge into one level; a trader must be able to tell them apart.
    const key = `${entry.price}:${entry.executable}`;
    const current = levels.get(key);
    if (!current) {
      levels.set(key, { price: entry.price, shares: entry.shares, orders: 1, source: entry.source, executable: entry.executable });
      continue;
    }
    current.shares += entry.shares;
    current.orders += 1;
    if (current.source !== entry.source) current.source = 'mixed';
  }
  // Best price first, and at an equal price the depth a trader can actually fill comes first.
  const sorted = [...levels.values()].sort((a, b) =>
    (book === 'asks' ? a.price - b.price : b.price - a.price) || Number(b.executable) - Number(a.executable));
  return sorted.slice(0, 12);
}

export function buildBook(curves: ActiveCurve[]): MarketBook {
  const build = (wantYes: boolean): OutcomeBook => {
    const entries = curves.flatMap(curve => entriesFor(curve, wantYes) ?? []);
    const asks = ladder(entries, 'asks'), bids = ladder(entries, 'bids');
    const bestAsk = asks.find(level => level.executable)?.price;
    const bestBid = bids.find(level => level.executable)?.price;
    return { asks, bids, spread: bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : null };
  };
  return { yes: build(true), no: build(false) };
}
