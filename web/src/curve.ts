/**
 * The browser's mirror of how Horizon prices and reads a curve.
 *
 * `contracts/src/CurveMath.sol` and the server are authoritative: the amounts a maker actually
 * posts come back from `POST /api/curves`, rebuilt through the deployed router, and the ladder is
 * built by `src/trading/liquidity.ts`. This mirrors the same exact integer integral and the same
 * restatement rules so a chart never disagrees with what the router will do.
 *
 * It deliberately imports nothing, which is what lets the API's own test suite check it against the
 * server implementation it mirrors.
 */
export type CurveShape = 1 | 2 | 3;
export type CurvePreview = { isBuy: boolean; startPrice: number; endPrice: number; shape: CurveShape; shares: bigint };

/** Marginal price in micro-USDC at a filled fraction of the curve. */
export function priceAt(curve: Pick<CurvePreview, 'startPrice' | 'endPrice' | 'shape'>, fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return curve.startPrice + (curve.endPrice - curve.startPrice) * clamped ** curve.shape;
}

/**
 * Cumulative cost of the first `q` shares, in USDC base units. BUY rounds down and SELL rounds
 * up, exactly as the contract does, so a preview never understates what a maker must post.
 */
export function cumulative(curve: CurvePreview, q: bigint): bigint {
  const size = curve.shares;
  if (size <= 0n || q <= 0n) return 0n;
  const shape = BigInt(curve.shape);
  const start = BigInt(curve.startPrice), end = BigInt(curve.endPrice);
  let denominator = (shape + 1n) * size ** shape;
  const delta = start > end ? start - end : end - start;
  const adjustment = delta * q ** (shape + 1n);
  const numerator = start * q * denominator + (curve.isBuy ? -adjustment : adjustment);
  denominator *= 1_000_000n;
  return curve.isBuy ? numerator / denominator : (numerator + denominator - 1n) / denominator;
}

/** What a BUY curve must fund, or what a fully filled SELL curve would return. */
export const totalCost = (curve: CurvePreview) => cumulative(curve, curve.shares);

/** The average price actually paid across the whole curve, in micro-USDC. */
export function averagePrice(curve: CurvePreview): number {
  if (curve.shares <= 0n) return curve.startPrice;
  return Number(totalCost(curve) * 1_000_000n / curve.shares);
}

/* -----------------------------------------------------------------------------
   Resting curves
   -----------------------------------------------------------------------------
   The editor previews a curve that has not been published. A market page reads
   curves that are already resting and partly filled, so every figure below is
   measured from the current fill position rather than from the start of the
   curve. The pricing function itself is untouched: a half-filled curve is the
   same function, sampled over the interval it has left.
   -------------------------------------------------------------------------- */

export type RestingCurve = CurvePreview & { filled: bigint };

/** What is still fillable. Cancelled and exhausted orders arrive here as zero. */
export const remainingOf = (curve: RestingCurve) => curve.shares > curve.filled ? curve.shares - curve.filled : 0n;

/**
 * Marginal price at an absolute filled quantity, rounded exactly as `marginalPrice` in
 * `src/trading/math.ts` rounds it, so the chart and the API agree on the price shown now.
 */
export function priceAtFilled(curve: RestingCurve, filled: bigint): number {
  if (curve.shares <= 0n) return curve.startPrice;
  const position = filled >= curve.shares ? 1 : Number(filled) / Number(curve.shares);
  return Math.round(curve.startPrice + (curve.endPrice - curve.startPrice) * position ** curve.shape);
}

export type Sample = { additional: bigint; price: number };

/**
 * The fillable part of a curve, as points of (shares filled from now, price per share). The first
 * sample is the price now and the last is the price once the order is exhausted, so a curve that is
 * already 90% filled draws only the short, steep tail it actually has left.
 */
export function sampleRemaining(curve: RestingCurve, steps = 40): Sample[] {
  const left = remainingOf(curve);
  if (left <= 0n) return [];
  const count = Math.max(1, steps);
  const points: Sample[] = [];
  for (let index = 0; index <= count; index++) {
    // Integer arithmetic on the share axis; the final point lands exactly on the remaining size.
    const additional = index === count ? left : (left * BigInt(index)) / BigInt(count);
    points.push({ additional, price: priceAtFilled(curve, curve.filled + additional) });
  }
  return points;
}

/**
 * What the next `q` shares average out to, in micro-USDC per share. This is what a taker of that
 * size actually pays or receives; `priceAtFilled` is the price of one more share at a point and is
 * never the cost of the whole quantity. Returns undefined when nothing is fillable.
 */
export function averageFillPrice(curve: RestingCurve, q: bigint): number | undefined {
  const to = curve.filled + q > curve.shares ? curve.shares : curve.filled + q;
  const span = to - curve.filled;
  if (span <= 0n) return undefined;
  return Number((cumulative(curve, to) - cumulative(curve, curve.filled)) * 1_000_000n / span);
}


/* -----------------------------------------------------------------------------
   Resting orders on a market
   -----------------------------------------------------------------------------
   How the market page reads what a market is resting. `src/trading/liquidity.ts`
   is authoritative and this mirrors its rules. Two of them matter here:

   - Orders on the other outcome are restated at `1 - price`. A resting BUY of
     the other outcome is an ask for this one, because a taker's contribution
     plus the maker's mints a fully backed pair.
   - A resting SELL of the other outcome would be a bid for this one only
     through sell-and-merge routing, which this release does not support. Those
     are carried as not executable rather than presented as depth a trader can
     hit — the same treatment the ladder gives them.
   -------------------------------------------------------------------------- */

/** One resting order as `GET /api/markets/:id` describes it. `api.ts` builds `Curve` from this. */
export type DescribedOrder = {
  id: string; maker: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  shape: number; isLimit: boolean; filled: string; remaining: string; price: number;
  strategy: { startPrice: number; endPrice: number; maxShares: string };
};

export type RestingOrder = {
  id: string; maker: string;
  /** The outcome and direction the maker published, never restated. */
  side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  /** Which side of *this* outcome's market the order sits on, after any restatement. */
  book: 'ask' | 'bid';
  /**
   * The direction the order reads as in the viewed outcome's terms, which is how it is labelled.
   * Buying YES at `p` and selling NO at `1 - p` are the same trade — the taker's contribution plus
   * the maker's mints a fully backed pair — so a BUY YES curve is a SELL NO curve to a NO buyer.
   * `direction` above keeps what the maker actually published.
   */
  viewDirection: 'BUY' | 'SELL';
  /** True when the order rests on the other outcome and is shown at `1 - price`. */
  complementary: boolean;
  /** False for depth that needs a route this release cannot build. */
  executable: boolean;
  shape: CurveShape;
  /** Equal endpoints: every remaining share fills at one price, so it belongs in the ladder. */
  isLimit: boolean;
  curve: RestingCurve;
  remaining: bigint;
  /** Marginal price now, in the viewed outcome's terms. */
  price: number;
};

const shapeOf = (shape: number): CurveShape => (shape === 2 || shape === 3 ? shape : 1);

const restingCurve = (curve: DescribedOrder): RestingCurve => ({
  isBuy: curve.direction === 'BUY', startPrice: curve.strategy.startPrice, endPrice: curve.strategy.endPrice,
  shape: shapeOf(curve.shape), shares: BigInt(curve.strategy.maxShares), filled: BigInt(curve.filled),
});

/** The mirror a complementary order is read through: a NO price of 0.4 is a YES price of 0.6. */
const mirror = (micro: number) => 1_000_000 - micro;

/**
 * One order in the viewed outcome's terms, or nothing when it has no capacity left. Cancelled and
 * expired orders never reach here: the API only describes orders that are still active.
 */
export function restate(curve: DescribedOrder, wantYes: boolean): RestingOrder | undefined {
  const resting = restingCurve(curve);
  const remaining = remainingOf(resting);
  if (remaining <= 0n) return undefined;
  const direct = (curve.side === 'YES') === wantYes;
  const buying = curve.direction === 'BUY';
  const complementary = !direct;
  // A resting buy is a bid for its own outcome and an offer of the other one; a resting sell is the
  // mirror of that. Which side of this book it lands on is therefore also what it reads as here.
  const book = direct ? (buying ? 'bid' : 'ask') : (buying ? 'ask' : 'bid');
  return {
    id: curve.id, maker: curve.maker, side: curve.side, direction: curve.direction,
    book, viewDirection: book === 'ask' ? 'SELL' as const : 'BUY' as const,
    complementary,
    // Direct depth is always routable; of the two complementary directions only a resting buy is.
    executable: direct || buying,
    shape: resting.shape, isLimit: curve.isLimit, curve: resting, remaining,
    price: direct ? curve.price : mirror(curve.price),
  };
}

/** Reads a price out of a restated order, applying the complementary mirror when there is one. */
export const priceIn = (order: RestingOrder, filled: bigint) =>
  order.complementary ? mirror(priceAtFilled(order.curve, filled)) : priceAtFilled(order.curve, filled);

/**
 * What `q` more shares average out to for the taker, in the viewed outcome's terms. A complementary
 * buy curve costs the taker `1 - maker price` per share, which is the same mirror the ladder uses.
 */
export function averageIn(order: RestingOrder, q: bigint): number | undefined {
  const average = averageFillPrice(order.curve, q);
  if (average === undefined) return undefined;
  return order.complementary ? mirror(average) : average;
}

/** The fillable tail of one order, already restated, ready to be drawn. */
export const samplesIn = (order: RestingOrder, steps?: number): Sample[] =>
  sampleRemaining(order.curve, steps).map(point =>
    order.complementary ? { additional: point.additional, price: mirror(point.price) } : point);

/**
 * Splits what the market is resting into the two things a trader has to read differently: orders
 * that fill every share at one price, and orders whose price moves as they fill. The split happens
 * before anything is aggregated, so curve depth can never be counted as fixed-price depth.
 */
export function separate(curves: DescribedOrder[], wantYes: boolean) {
  const orders = curves.flatMap(curve => restate(curve, wantYes) ?? []);
  return { limits: orders.filter(order => order.isLimit), curves: orders.filter(order => !order.isLimit) };
}

/** Curve depth for one outcome, best price first: cheapest ask, then highest bid. */
export function curveOrders(curves: DescribedOrder[], wantYes: boolean): RestingOrder[] {
  return separate(curves, wantYes).curves.sort((a, b) =>
    a.book === b.book ? (a.book === 'ask' ? a.price - b.price : b.price - a.price) : a.book === 'ask' ? -1 : 1);
}
