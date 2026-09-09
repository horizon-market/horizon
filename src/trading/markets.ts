import { createPublicClient, http, erc20Abi, encodeAbiParameters, parseAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { GraphProvider, type IndexedMarket } from './graph.js';
import { cumulative, type Curve } from './math.js';
import { buildBook, summarize, type MarketLiquidity } from './liquidity.js';
import { aquaAbi, marketAbi, registryAbi, routerAbi } from './abi.js';
import type { TradingConfig } from './service.js';

export class MarketError extends Error {}
export const RESULTS = ['UNRESOLVED', 'YES', 'NO', 'INVALID'] as const;
export type PublishInput = { maker: Address; market: Address; isYes: boolean; isBuy: boolean; startPrice: number; endPrice: number; shares: bigint; shape: number; salt?: Hex };
export type RedeemInput = { account: Address; market: Address; yesShares: bigint; noShares: bigint; recipient: Address };

export type MarketSummary = IndexedMarket & { liquidity: MarketLiquidity; status: 'OPEN' | 'CLOSED' | 'RESOLVED' };

const status = (market: IndexedMarket, now: number): MarketSummary['status'] =>
  market.result !== 0 ? 'RESOLVED' : market.closeAt <= now ? 'CLOSED' : 'OPEN';

/**
 * Application reads for the frontend. Discovery is Graph-backed; anything a user is about to
 * sign is rebuilt and re-checked through RPC first. Trading itself carries no fee of any kind.
 */
export class MarketService {
  readonly graph: GraphProvider;
  readonly client;
  constructor(readonly config: TradingConfig) {
    this.graph = new GraphProvider(config.graph, config.graphKey);
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) });
  }

  private decorate(markets: IndexedMarket[]) {
    const now = Math.floor(Date.now() / 1000);
    return markets.map(market => ({ ...market, status: status(market, now), liquidity: summarize(market.curves) }));
  }

  async list() {
    const snapshot = await this.graph.indexedMarkets();
    return { indexedBlock: snapshot.block, indexedHash: snapshot.hash, fees: { maker: 0, taker: 0, routing: 0, protocol: 0 }, markets: this.decorate(snapshot.markets) };
  }

  /** Market detail refreshes open status, collateral and result through RPC before display. */
  async detail(market: Address) {
    const snapshot = await this.graph.indexedMarket(market);
    const indexed = snapshot.markets[0];
    if (!indexed) throw new MarketError('unknown_market');
    const [registered, isOpen, result, collateral] = await Promise.all([
      this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'isMarket', args: [market] }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'isOpen' }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'result' }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'collateral' }),
    ]);
    if (!registered) throw new MarketError('unknown_market');
    const [summary] = this.decorate([{ ...indexed, result, collateral }]);
    return { indexedBlock: snapshot.block, indexedHash: snapshot.hash, fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
      book: buildBook(indexed.curves),
      market: { ...summary!, status: result !== 0 ? 'RESOLVED' : isOpen ? 'OPEN' : 'CLOSED', chainConfirmed: true } };
  }

  /** Holdings come from live token balances, not indexed transfers. */
  async positions(account: Address) {
    const snapshot = await this.graph.indexedMarkets();
    const markets = snapshot.markets;
    if (markets.length === 0) return { indexedBlock: snapshot.block, positions: [] };
    const balances = await this.client.multicall({
      allowFailure: false,
      contracts: markets.flatMap(market => [
        { address: market.yesToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] } as const,
        { address: market.noToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] } as const,
      ]),
    });
    const now = Math.floor(Date.now() / 1000);
    const positions = markets.flatMap((market, index) => {
      const yes = balances[index * 2] as bigint, no = balances[index * 2 + 1] as bigint;
      if (yes === 0n && no === 0n) return [];
      const state = status(market, now);
      // INVALID pays half a USDC base unit per outcome token; the market keeps each holder's remainder.
      const redeemable = market.result === 1 ? yes : market.result === 2 ? no : market.result === 3 ? (yes + no) / 2n : 0n;
      return [{ market: market.id, question: market.question, closeAt: market.closeAt, status: state,
        result: RESULTS[market.result], yesToken: market.yesToken, noToken: market.noToken,
        yes: yes.toString(), no: no.toString(), redeemableUsdc: redeemable.toString() }];
    });
    return { indexedBlock: snapshot.block, positions };
  }

  /**
   * A maker's own published curves. Indexed state is enough to list and cancel them; a fill still
   * depends on the wallet balance the curve's Aqua allocation draws on, which is shared.
   */
  async curvesFor(maker: Address) {
    const snapshot = await this.graph.curvesByMaker(maker);
    const now = Math.floor(Date.now() / 1000);
    return { indexedBlock: snapshot.block, curves: snapshot.curves.map(curve => {
      const isYes = (curve.flags & 1) !== 0, isBuy = (curve.flags & 2) !== 0;
      const remaining = curve.maxShares > curve.filled ? curve.maxShares - curve.filled : 0n;
      return {
        orderHash: curve.id, market: curve.market, question: curve.question,
        side: isYes ? 'YES' : 'NO', direction: isBuy ? 'BUY' : 'SELL', shape: curve.flags >> 2,
        startPrice: curve.startPrice, endPrice: curve.endPrice,
        // Equal endpoints never move with the fill, which is what makes them a limit order.
        isLimit: curve.startPrice === curve.endPrice,
        maxShares: curve.maxShares.toString(), filled: curve.filled.toString(), remaining: remaining.toString(),
        active: curve.active, publishedAt: curve.publishedAt, closeAt: curve.closeAt,
        outcomeToken: isYes ? curve.yesToken : curve.noToken,
        marketStatus: curve.result !== 0 ? 'RESOLVED' : curve.closeAt <= now ? 'CLOSED' : 'OPEN',
        cancellable: curve.active && remaining > 0n,
      };
    }) };
  }

  private validatePublish(input: PublishInput): Curve {
    if (!Number.isInteger(input.shape) || input.shape < 1 || input.shape > 3) throw new MarketError('invalid_shape');
    for (const price of [input.startPrice, input.endPrice]) {
      if (!Number.isInteger(price) || price <= 0 || price >= 1_000_000) throw new MarketError('invalid_price_bounds');
    }
    // BUY prices decline as the maker accumulates; SELL prices rise as inventory leaves. Equal endpoints are a limit order.
    if (input.isBuy ? input.endPrice > input.startPrice : input.endPrice < input.startPrice) throw new MarketError('invalid_price_direction');
    if (input.shares < 1_000_000n || input.shares > 10n ** 15n) throw new MarketError('invalid_size');
    return { market: input.market, flags: input.shape * 4 + (input.isBuy ? 2 : 0) + (input.isYes ? 1 : 0),
      startPrice: input.startPrice, endPrice: input.endPrice, maxShares: input.shares,
      salt: input.salt ?? keccak256(`0x${Buffer.from(`${input.maker}:${Date.now()}:${Math.random()}`).toString('hex')}` as Hex) };
  }

  /**
   * Prepares a curve publication for the maker's own wallet. Selling acquired outcomes always
   * requires this explicit step: receiving outcome tokens never creates a sell authorization.
   */
  async preparePublication(input: PublishInput) {
    const strategy = this.validatePublish(input);
    const [registered, isOpen] = await Promise.all([
      this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'isMarket', args: [input.market] }),
      this.client.readContract({ address: input.market, abi: marketAbi, functionName: 'isOpen' }),
    ]);
    if (!registered) throw new MarketError('unknown_market');
    if (!isOpen) throw new MarketError('market_closed');
    const outcome = await this.client.readContract({ address: this.config.router, abi: routerAbi, functionName: 'curveOutcome', args: [strategy] }) as Address;
    const expected = await this.client.readContract({ address: input.market, abi: marketAbi, functionName: input.isYes ? 'yesToken' : 'noToken' }) as Address;
    if (outcome.toLowerCase() !== expected.toLowerCase()) throw new MarketError('outcome_token_mismatch');
    const order = await this.client.readContract({ address: this.config.router, abi: routerAbi, functionName: 'buildCurveOrder', args: [input.maker, strategy] });
    const encoded = encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'), [order]);
    // A BUY posts a USDC budget and no inventory; a SELL posts inventory and no budget.
    const budget = input.isBuy ? cumulative(strategy, strategy.maxShares) : 0n;
    const amounts = input.isBuy ? [0n, budget] : [strategy.maxShares, 0n];
    const fundingToken = input.isBuy ? this.config.usdc : outcome;
    const fundingAmount = input.isBuy ? budget : strategy.maxShares;
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ address: fundingToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.maker] }),
      this.client.readContract({ address: fundingToken, abi: erc20Abi, functionName: 'allowance', args: [input.maker, this.config.aqua] }),
    ]) as [bigint, bigint];
    return {
      strategy: { ...strategy, maxShares: strategy.maxShares.toString() }, orderHash: keccak256(encoded),
      outcomeToken: outcome, tokens: [outcome, this.config.usdc], amounts: amounts.map(String),
      // Aqua allocations are permissions over a shared wallet balance, not reserved funds.
      shared: input.isBuy ? 'USDC allocations are shared with this wallet’s other markets; a fill elsewhere reduces what remains here.'
        : 'Outcome tokens are bound to this market and outcome and are never reused by another market.',
      readiness: balance < fundingAmount ? 'insufficient_balance' : allowance < fundingAmount ? 'approval_required' : 'ready',
      approval: { token: fundingToken, spender: this.config.aqua, amount: fundingAmount.toString() },
      transaction: { to: this.config.aqua, value: '0',
        data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [this.config.router, encoded, [outcome, this.config.usdc], amounts] }) },
      fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
    };
  }

  /** Cancelling withdraws every token allocated to one order; changing terms needs a new order. */
  async prepareCancellation(input: { maker: Address; market: Address; orderHash: Hex; outcomeToken: Address }) {
    const registered = await this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'isMarket', args: [input.market] });
    if (!registered) throw new MarketError('unknown_market');
    return { transaction: { to: this.config.aqua, value: '0',
      data: encodeFunctionData({ abi: aquaAbi, functionName: 'dock', args: [this.config.router, input.orderHash, [input.outcomeToken, this.config.usdc]] }) } };
  }

  async prepareRedemption(input: RedeemInput) {
    if (input.yesShares < 0n || input.noShares < 0n || (input.yesShares === 0n && input.noShares === 0n)) throw new MarketError('invalid_size');
    const [registered, result] = await Promise.all([
      this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'isMarket', args: [input.market] }),
      this.client.readContract({ address: input.market, abi: marketAbi, functionName: 'result' }),
    ]);
    if (!registered) throw new MarketError('unknown_market');
    if (result === 0) throw new MarketError('market_unresolved');
    const [yesToken, noToken] = await Promise.all([
      this.client.readContract({ address: input.market, abi: marketAbi, functionName: 'yesToken' }),
      this.client.readContract({ address: input.market, abi: marketAbi, functionName: 'noToken' }),
    ]) as [Address, Address];
    const [yesBalance, noBalance, remainder] = await Promise.all([
      this.client.readContract({ address: yesToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.account] }),
      this.client.readContract({ address: noToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.account] }),
      this.client.readContract({ address: input.market, abi: marketAbi, functionName: 'invalidRemainder', args: [input.account] }),
    ]) as [bigint, bigint, bigint];
    if (input.yesShares > yesBalance || input.noShares > noBalance) throw new MarketError('insufficient_outcome_balance');
    const payout = result === 1 ? input.yesShares : result === 2 ? input.noShares : (input.yesShares + input.noShares + remainder) / 2n;
    return { result: RESULTS[result], payoutUsdc: payout.toString(),
      transaction: { to: input.market, value: '0',
        data: encodeFunctionData({ abi: marketAbi, functionName: 'redeem', args: [input.yesShares, input.noShares, input.recipient] }) } };
  }
}
