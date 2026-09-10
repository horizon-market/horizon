import type { Address, Hex } from 'viem';
import { cumulative, isBuy, isYes, type CurveShape } from './math.js';

/**
 * Per-market order budgets.
 *
 * A maker's USDC is shared across markets through Aqua and stays shared: a commitment in market A
 * is never subtracted from market B's budget. What this module accounts for is the other half of
 * that arrangement — inside **one** market, every order the maker has resting that spends the same
 * token is added together, so the same money cannot be promised twice over.
 *
 * Groups are (maker, market, funding token). A BUY spends USDC whichever outcome it names, so BUY
 * YES and BUY NO share one budget. A SELL spends that market's YES or NO token, and those are
 * different contracts, so each has a budget of its own. Outcome tokens are never shared between
 * markets in the first place; the grouping simply keeps two sell orders from offering the same
 * inventory twice.
 *
 * The same rule is implemented in `OrderBudget`, the ledger the Horizon router owns, which enforces
 * it when an order is admitted. That is the refusal that binds. This module is what the API
 * computes and displays before a maker signs, and what the enforcement is checked against.
 */

export const normalize = (value: string) => value.toLowerCase() as Address;
export const groupKey = (maker: string, market: string, token: string) =>
  `${normalize(maker)}:${normalize(market)}:${normalize(token)}`;

/** Aqua marks a docked strategy with this token count; zero means it was never shipped. */
export const AQUA_DOCKED = 255;

/**
 * One admitted order, as the chain reports it now. `owed` is the router ledger's own figure: the
 * exact obligation recorded when the order was admitted, less exactly what each fill has since
 * spent. `allocation` is the order's Aqua balance for `token`.
 */
export type OpenOrder = {
  orderHash: Hex;
  /** The single token this order can spend: USDC for a BUY, the outcome token for a SELL. */
  token: Address;
  /** YES in bit 0, BUY in bit 1 — enough to describe the order without re-reading the strategy. */
  flags: number;
  owed: bigint;
  filled: bigint;
  allocation: bigint;
  /** Aqua's token count for this strategy: 0 never shipped, 255 docked, otherwise live. */
  tokensCount: number;
};

export type OrderCommitment = {
  orderHash: Hex; token: Address; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  filled: bigint; owed: bigint; allocation: bigint; remaining: bigint; terminal: boolean;
};

/**
 * What a new order would owe if it filled to its published size. A BUY owes the exact integral of
 * its curve over the size it has left — never share quantity, never the opening price times the
 * size, and never the original budget once part of it has been spent. A SELL owes the outcome
 * tokens it has not delivered. Equal endpoints are a fixed-price order and go through the same
 * arithmetic, which is what keeps limit orders inside this accounting.
 *
 * This is the figure the router records at admission, computed here so a publication can be
 * checked and explained before the maker signs anything.
 */
export const obligationOf = (order: CurveShape & { filled: bigint }) =>
  isBuy(order)
    ? cumulative(order, order.maxShares) - cumulative(order, order.filled)
    : order.maxShares - order.filled;

/**
 * The order's remaining commitment, reconciled against Aqua. `terminal` marks an order that can
 * never spend again — cancelled by the maker, or filled to its size — and only that releases a
 * commitment. An order whose Aqua allocation has run out contributes nothing while it stands, but
 * is not terminal: a later push can refund it. An underfunded wallet is never a reason to drop an
 * outstanding commitment, because that would invent room for further orders.
 */
export function commitmentOf(order: OpenOrder): OrderCommitment {
  const cancelled = order.tokensCount === AQUA_DOCKED || order.tokensCount === 0;
  // An order filled to its size owes exactly zero: the cumulative integral telescopes.
  const terminal = cancelled || order.owed === 0n;
  // Aqua will not release more than the order's own allocation, so that caps what it can still spend.
  const remaining = terminal ? 0n : order.owed < order.allocation ? order.owed : order.allocation;
  return {
    orderHash: order.orderHash, token: normalize(order.token),
    side: isYes(order) ? 'YES' : 'NO', direction: isBuy(order) ? 'BUY' : 'SELL',
    filled: order.filled, owed: terminal ? 0n : order.owed, allocation: order.allocation,
    remaining, terminal,
  };
}

export type Committed = { total: bigint; orders: OrderCommitment[] };

/** Everything already committed in one group. Orders spending another token are not this budget. */
export function committedIn(orders: OpenOrder[], token: Address): Committed {
  const wanted = normalize(token);
  const live = orders.map(commitmentOf).filter(order => order.token === wanted && !order.terminal);
  return { total: live.reduce((sum, order) => sum + order.remaining, 0n), orders: live };
}

export type Budget = {
  token: Address; balance: bigint; allowance: bigint; spendable: bigint;
  committed: bigint; available: bigint; overcommitted: boolean;
  orders: OrderCommitment[];
};

/**
 * A group's whole budget. Spendable is the lesser of the balance and the allowance to the spender
 * that actually moves the funds — Aqua for a maker order. An allowance is not money, and money the
 * spender may not touch cannot be spent either.
 *
 * `available` is zero rather than negative when shared funds were spent in another market,
 * withdrawn, or de-approved. The market is then over budget: it admits nothing further until the
 * maker cancels an order or refunds the wallet. Nothing is reserved and no fill is promised.
 */
export function budgetOf(input: { token: Address; balance: bigint; allowance: bigint; orders: OpenOrder[] }): Budget {
  const spendable = input.balance < input.allowance ? input.balance : input.allowance;
  const { total, orders } = committedIn(input.orders, input.token);
  return {
    token: normalize(input.token), balance: input.balance, allowance: input.allowance, spendable,
    committed: total, available: spendable > total ? spendable - total : 0n,
    overcommitted: total > spendable, orders,
  };
}

export type CapacityCheck =
  | { ok: true; budget: Budget; requested: bigint }
  | { ok: false; budget: Budget; requested: bigint; shortfall: bigint };

/** The rule itself: what is already committed plus what this order would commit must fit. */
export function checkCapacity(budget: Budget, requested: bigint): CapacityCheck {
  const total = budget.committed + requested;
  return total <= budget.spendable
    ? { ok: true, budget, requested }
    : { ok: false, budget, requested, shortfall: total - budget.spendable };
}
