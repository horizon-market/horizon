import type { Address, Hex } from 'viem';

export type Curve = { market: Address; flags: number; startPrice: number; endPrice: number; maxShares: bigint; salt: Hex };
export const isBuy = (s: Curve) => (s.flags & 2) !== 0;
export const isYes = (s: Curve) => (s.flags & 1) !== 0;
export function cumulative(s: Curve, q: bigint): bigint {
  const shape = s.flags >> 2, start = BigInt(s.startPrice), end = BigInt(s.endPrice), size = s.maxShares;
  if (size <= 0n || size > 10n ** 15n || q < 0n || q > size || shape < 1 || shape > 3
    || start <= 0n || end <= 0n || start >= 1_000_000n || end >= 1_000_000n
    || (isBuy(s) ? end > start : end < start)) throw new Error('invalid_curve');
  let denominator = BigInt(shape + 1) * size ** BigInt(shape);
  const delta = start > end ? start - end : end - start;
  const adjustment = delta * q ** BigInt(shape + 1);
  const numerator = start * q * denominator + (isBuy(s) ? -adjustment : adjustment);
  denominator *= 1_000_000n;
  return isBuy(s) ? numerator / denominator : (numerator + denominator - 1n) / denominator;
}
export function curveCost(s: Curve, filled: bigint, shares: bigint): bigint {
  return cumulative(s, filled + shares) - cumulative(s, filled);
}

/** Marginal price in micro-USDC at the current fill position; display only, never a quote. */
export function marginalPrice(s: Curve, filled: bigint): number {
  const shape = s.flags >> 2;
  const size = s.maxShares;
  if (size <= 0n || shape < 1 || shape > 3) throw new Error('invalid_curve');
  const position = filled >= size ? 1 : Number(filled) / Number(size);
  return Math.round(s.startPrice + (s.endPrice - s.startPrice) * position ** shape);
}
