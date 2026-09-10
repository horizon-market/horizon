import test from 'node:test';
import assert from 'node:assert/strict';
import type { Address, Hex } from 'viem';
import { AQUA_DOCKED, budgetOf, checkCapacity, committedIn, commitmentOf, groupKey, obligationOf,
  type OpenOrder } from '../src/trading/budget.js';
import type { CurveShape } from '../src/trading/math.js';

const USDC = '0x0000000000000000000000000000000000000011' as Address;
const YES = '0x0000000000000000000000000000000000000022' as Address;
const NO = '0x0000000000000000000000000000000000000033' as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

let counter = 0;
/** A flat BUY YES of ten shares at 0.40 USDC, fully allocated: four USDC of obligation. */
const order = (overrides: Partial<OpenOrder> = {}): OpenOrder => ({
  orderHash: hash(++counter), token: USDC, flags: 7, owed: 4_000_000n,
  filled: 0n, allocation: 4_000_000n, tokensCount: 2, ...overrides,
});
const sell = (token: Address, overrides: Partial<OpenOrder> = {}) =>
  order({ token, flags: token === YES ? 5 : 4, owed: 10_000_000n, allocation: 10_000_000n, ...overrides });
/** The published shape of an order, which is what its obligation is derived from. */
const curve = (over: Partial<CurveShape & { filled: bigint }> = {}): CurveShape & { filled: bigint } =>
  ({ flags: 7, startPrice: 400_000, endPrice: 400_000, maxShares: 10_000_000n, filled: 0n, ...over });

const usdcBudget = (balance: bigint, allowance: bigint, orders: OpenOrder[]) =>
  budgetOf({ token: USDC, balance, allowance, orders });

test('a fixed-price order and a curve in one market share one USDC budget', () => {
  // A limit order is a curve with equal endpoints; the obligation comes from the same integral.
  assert.equal(obligationOf(curve()), 4_000_000n);
  // And for a curve it is the exact integral over the size, never the opening price times the size.
  assert.equal(obligationOf(curve({ flags: 6, endPrice: 200_000 })), 3_000_000n);
  assert.equal(obligationOf(curve({ flags: 10, endPrice: 200_000 })), 3_333_333n);
  // A SELL owes outcome tokens, so its obligation is what it has not yet delivered.
  assert.equal(obligationOf(curve({ flags: 5, startPrice: 600_000, endPrice: 800_000, filled: 4_000_000n })), 6_000_000n);
  const orders = [order(), order({ flags: 6, owed: 3_000_000n, allocation: 3_000_000n })];
  const budget = usdcBudget(7_000_000n, 7_000_000n, orders);
  assert.equal(budget.committed, 7_000_000n);
  assert.equal(budget.available, 0n);
  assert.equal(budget.orders.length, 2);
  assert.equal(budget.overcommitted, false);
});

test('buying YES and buying NO draw on the same market USDC budget', () => {
  const orders = [order({ flags: 7, owed: 3_000_000n, allocation: 3_000_000n }),
    order({ flags: 6, owed: 2_000_000n, allocation: 2_000_000n })];
  const budget = usdcBudget(5_000_000n, 5_000_000n, orders);
  assert.equal(budget.committed, 5_000_000n);
  assert.equal(checkCapacity(budget, 1n).ok, false);
});

test('YES and NO sell inventories are separate budgets in the same market', () => {
  const orders = [sell(YES), sell(NO)];
  const yes = budgetOf({ token: YES, balance: 20_000_000n, allowance: 10_000_000n, orders });
  const no = budgetOf({ token: NO, balance: 20_000_000n, allowance: 10_000_000n, orders });
  assert.equal(yes.committed, 10_000_000n);
  assert.equal(no.committed, 10_000_000n);
  assert.equal(yes.orders.length, 1);
  // Selling inventory never touches the USDC budget, and neither sell sees the other's token.
  assert.equal(usdcBudget(5_000_000n, 5_000_000n, orders).committed, 0n);
  assert.equal(checkCapacity(yes, 1n).ok, false);
});

test('an order that fits exactly is accepted and one base unit more is not', () => {
  const budget = usdcBudget(4_000_000n, 4_000_000n, [order()]);
  assert.equal(budget.available, 0n);
  const exact = usdcBudget(8_000_000n, 8_000_000n, [order()]);
  assert.equal(checkCapacity(exact, 4_000_000n).ok, true);
  const over = checkCapacity(exact, 4_000_001n);
  assert.equal(over.ok, false);
  assert.equal(over.ok === false && over.shortfall, 1n);
});

test('spendable funds are the lesser of the balance and the allowance to Aqua', () => {
  assert.equal(usdcBudget(10_000_000n, 4_000_000n, []).spendable, 4_000_000n);
  assert.equal(usdcBudget(3_000_000n, 10_000_000n, []).spendable, 3_000_000n);
  // Approving does not create funds, and an unapproved balance cannot be moved by the spender.
  assert.equal(checkCapacity(usdcBudget(10_000_000n, 4_000_000n, []), 5_000_000n).ok, false);
  assert.equal(checkCapacity(usdcBudget(3_000_000n, 10_000_000n, []), 5_000_000n).ok, false);
});

test('a partial fill reduces the obligation by the integrated amount, not by share count', () => {
  // Shape 2 declining 0.40 → 0.20: one share costs 0.399333 by cumulative floor rounding, and the
  // remaining obligation is the integral over what is left — not a tenth off, and not a whole share.
  const shape = curve({ flags: 10, endPrice: 200_000 });
  assert.equal(obligationOf(shape), 3_333_333n);
  assert.equal(obligationOf({ ...shape, filled: 1_000_000n }), 3_333_333n - 399_333n);
  const partial = order({ flags: 10, owed: 2_934_000n, filled: 1_000_000n, allocation: 2_934_000n });
  const budget = usdcBudget(9_600_667n, 9_600_667n, [partial]);
  // A fill moves the commitment and the wallet together, so the room for a new order is unchanged.
  assert.equal(budget.committed, 2_934_000n);
  assert.equal(budget.available, 9_600_667n - 2_934_000n);
  assert.equal(usdcBudget(10_000_000n, 10_000_000n, [order()]).available, 6_000_000n);
});

test('a fill is never treated as a cancellation', () => {
  const half = order({ owed: 2_000_000n, filled: 5_000_000n, allocation: 2_000_000n });
  const commitment = commitmentOf(half);
  assert.equal(commitment.terminal, false);
  assert.equal(commitment.remaining, 2_000_000n);
});

test('cancelled and exhausted orders release their whole commitment', () => {
  assert.equal(commitmentOf(order({ tokensCount: AQUA_DOCKED, allocation: 0n })).remaining, 0n);
  assert.equal(commitmentOf(order({ tokensCount: AQUA_DOCKED, allocation: 0n })).terminal, true);
  // Filled to its size, an order owes exactly zero: the cumulative integral telescopes.
  assert.equal(commitmentOf(order({ owed: 0n, filled: 10_000_000n, allocation: 0n })).terminal, true);
  const budget = usdcBudget(7_000_000n, 7_000_000n, [order(), order({ tokensCount: AQUA_DOCKED, allocation: 0n })]);
  assert.equal(budget.committed, 4_000_000n);
  assert.equal(budget.available, 3_000_000n);
});

test('an order whose Aqua allocation ran out commits nothing but is not released', () => {
  // A later Aqua push can refund it, so it stays in the market's list rather than being dropped.
  const drained = commitmentOf(order({ allocation: 0n }));
  assert.equal(drained.remaining, 0n);
  assert.equal(drained.terminal, false);
  assert.equal(drained.owed, 4_000_000n);
});

test('an underfunded wallet never releases an outstanding commitment', () => {
  const budget = usdcBudget(1_000_000n, 10_000_000n, [order()]);
  assert.equal(budget.spendable, 1_000_000n);
  // Counting the order at anything less than four USDC would invent room for another order here.
  assert.equal(budget.committed, 4_000_000n);
  assert.equal(budget.available, 0n);
  assert.equal(budget.overcommitted, true);
  assert.equal(checkCapacity(budget, 1n).ok, false);
});

test('reduced allowance leaves a market over budget exactly as a withdrawal does', () => {
  const withdrawn = usdcBudget(3_000_000n, 10_000_000n, [order({ owed: 8_000_000n, allocation: 8_000_000n })]);
  const deapproved = usdcBudget(10_000_000n, 3_000_000n, [order({ owed: 8_000_000n, allocation: 8_000_000n })]);
  for (const budget of [withdrawn, deapproved]) {
    assert.equal(budget.spendable, 3_000_000n);
    assert.equal(budget.committed, 8_000_000n);
    assert.equal(budget.overcommitted, true);
  }
});

test('markets are accounted separately over the same shared wallet', () => {
  const inA = [order()], inB = [order()];
  const wallet = { balance: 10_000_000n, allowance: 10_000_000n };
  // Neither market subtracts the other's commitments: that is what shared USDC means.
  assert.equal(budgetOf({ token: USDC, ...wallet, orders: inA }).available, 6_000_000n);
  assert.equal(budgetOf({ token: USDC, ...wallet, orders: inB }).available, 6_000_000n);
  assert.notEqual(groupKey('0xA1', '0xMarketA', USDC), groupKey('0xA1', '0xMarketB', USDC));
});

test('grouping normalises addresses, so a checksummed token is the same budget', () => {
  const mixed = USDC.toUpperCase().replace('0X', '0x') as Address;
  assert.equal(groupKey('0xAbCd', '0xEeFf', mixed), groupKey('0xabcd', '0xeeff', USDC));
  assert.equal(committedIn([order({ token: mixed })], USDC).total, 4_000_000n);
  assert.equal(committedIn([order()], mixed).total, 4_000_000n);
});

test('the commitment never exceeds the order own Aqua allocation', () => {
  // A maker may allocate less than the curve owes; Aqua will not release more than it holds.
  assert.equal(commitmentOf(order({ allocation: 1_500_000n })).remaining, 1_500_000n);
  // Allocating more than the curve owes does not commit more: the curve cannot spend it.
  assert.equal(commitmentOf(order({ allocation: 9_000_000n })).remaining, 4_000_000n);
});
