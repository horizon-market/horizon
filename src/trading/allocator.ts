import type { Address, Hex } from 'viem';
import { curveCost, isBuy, type Curve } from './math.js';

export type Candidate = { id: Hex; maker: Address; strategy: Curve; filled: bigint; allocation: bigint; walletAvailable: bigint; outputToken: Address };
export type Fill = { candidate: Candidate; shares: bigint };
export class RoutingError extends Error {}
const min = (a: bigint, b: bigint) => a < b ? a : b;

// Bounded chunk search, not a claim of globally optimal routing. Integer quotes are exact for the chosen fills.
export function allocate(candidates: Candidate[], shares: bigint, buying: boolean): { fills: Fill[]; usdc: bigint } {
  if (candidates.length > 32 || shares < 1_000_000n || shares > 10n ** 15n) throw new RoutingError('invalid_size_or_candidate_count');
  const wallet = new Map<string, bigint>();
  const key = (c: Candidate) => `${c.maker.toLowerCase()}:${c.outputToken.toLowerCase()}`;
  for (const c of candidates) wallet.set(key(c), min(wallet.get(key(c)) ?? c.walletAvailable, c.walletAvailable));
  const amounts = new Map<Hex, bigint>();
  const budget = new Map(candidates.map(c => [c.id, c.allocation]));
  let remaining = shares;
  const chunk = (shares + 127n) / 128n;
  for (let iteration = 0; remaining > 0n && iteration < 256; iteration++) {
    let best: { c: Candidate; q: bigint; cost: bigint; out: bigint } | undefined;
    for (const c of candidates) {
      if (!amounts.has(c.id) && amounts.size >= 4) continue;
      const already = amounts.get(c.id) ?? 0n;
      const capacity = min(c.strategy.maxShares - c.filled - already, remaining);
      const funds = min(wallet.get(key(c)) ?? 0n, budget.get(c.id) ?? 0n);
      if (capacity <= 0n || funds <= 0n) continue;
      let q = min(capacity, chunk);
      const outputFor = (n: bigint) => isBuy(c.strategy) ? curveCost(c.strategy, c.filled + already, n) : n;
      if (outputFor(q) > funds) {
        let lo = 0n, hi = q;
        while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (outputFor(mid) <= funds) lo = mid; else hi = mid - 1n; }
        q = lo;
      }
      if (q === 0n) continue;
      const makerCost = curveCost(c.strategy, c.filled + already, q);
      if (makerCost <= 0n || makerCost >= q) continue;
      const cost = buying && isBuy(c.strategy) ? q - makerCost : makerCost;
      if (!best || (buying ? cost * best.q < best.cost * q : cost * best.q > best.cost * q)) best = { c, q, cost, out: outputFor(q) };
    }
    if (!best) throw new RoutingError('insufficient_executable_liquidity');
    const { c, q, out } = best;
    amounts.set(c.id, (amounts.get(c.id) ?? 0n) + q);
    wallet.set(key(c), wallet.get(key(c))! - out);
    budget.set(c.id, budget.get(c.id)! - out);
    remaining -= q;
  }
  if (remaining !== 0n) throw new RoutingError('search_limit_reached');
  const fills = [...amounts].map(([id, q]) => ({ candidate: candidates.find(c => c.id === id)!, shares: q }));
  const usdc = fills.reduce((total, f) => {
    const cost = curveCost(f.candidate.strategy, f.candidate.filled, f.shares);
    return total + (buying && isBuy(f.candidate.strategy) ? f.shares - cost : cost);
  }, 0n);
  return { fills, usdc };
}
