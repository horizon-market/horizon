/**
 * Preview arithmetic for the curve editor.
 *
 * `contracts/src/CurveMath.sol` and the server quote service are authoritative: the amounts a
 * maker actually posts come back from `POST /api/curves`, rebuilt through the deployed router.
 * This mirrors the same exact integer integral so the chart and the prepared order agree.
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
