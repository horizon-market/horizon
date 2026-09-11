import { createPublicClient, http, erc20Abi, encodeAbiParameters, parseAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { GraphProvider, type IndexedMarket, type IndexedSnapshot, type MakerCurve, type OperatorRoute } from './graph.js';
import type { MarketProjectionStore } from './projection.js';
import { applyMakerOverlay, applyOverlay, type LiveStore, type LiveTrade, type MarketRef, type OverlayChange } from './overlay.js';
import type { Curve } from './math.js';
import { budgetOf, checkCapacity, obligationOf, type Budget, type OpenOrder } from './budget.js';
import { buildBook, describeCurves, summarize, type CurveDescription, type MarketLiquidity } from './liquidity.js';
import { aquaAbi, marketAbi, orderBudgetAbi, registryAbi, routerAbi } from './abi.js';
import type { TradingConfig } from './service.js';

/** `details` travels with the API error so a refusal can state the amounts it was decided on. */
export class MarketError extends Error {
  constructor(message: string, readonly details?: Record<string, unknown>) { super(message); }
}
export const RESULTS = ['UNRESOLVED', 'YES', 'NO', 'INVALID'] as const;
export type PublishInput = { maker: Address; market: Address; isYes: boolean; isBuy: boolean; startPrice: number; endPrice: number; shares: bigint; shape: number; salt?: Hex };
export type RedeemInput = { account: Address; market: Address; yesShares: bigint; noShares: bigint; recipient: Address };

/** How an order's funding is described to a maker: the asset, the budget, and what is left. */
export type FundingBudget = Budget & { asset: 'USDC' | 'YES' | 'NO'; decimals: number };
export type MarketBudgets = {
  block: number; market: Address; maker: Address; spender: Address; marketOpen: boolean;
  usdc: FundingBudget; yes: FundingBudget; no: FundingBudget;
};

export type MarketSummary = Omit<IndexedMarket, 'curves'> & {
  liquidity: MarketLiquidity; status: 'OPEN' | 'CLOSED' | 'RESOLVED'; curves: CurveDescription[];
};
/** Which store answered a read: the local mirror, or The Graph directly. */
export type Source = 'projection' | 'graph';
export type { IndexedSnapshot };

const status = (market: IndexedMarket, now: number): MarketSummary['status'] =>
  market.result !== 0 ? 'RESOLVED' : market.closeAt <= now ? 'CLOSED' : 'OPEN';

/**
 * Application reads for the frontend. Discovery is Graph-backed; anything a user is about to
 * sign is rebuilt and re-checked through RPC first. Trading itself carries no fee of any kind.
 */
export class MarketService {
  readonly graph: GraphProvider;
  readonly client;
  private ledger?: Promise<Address>;
  constructor(readonly config: TradingConfig, private projection?: MarketProjectionStore, private live?: LiveStore) {
    this.graph = new GraphProvider(config.graph, config.graphKey);
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) });
  }

  /**
   * The live layer over whichever snapshot answered: changes the stream recorded after the
   * snapshot's block, and nothing older. A failing live read degrades to the snapshot alone; it
   * never fails the request, because the snapshot is correct on its own, only later.
   */
  private async changesAfter(block: number, scope: { market?: string; maker?: string } = {}): Promise<OverlayChange[]> {
    if (!this.live) return [];
    try { return await this.live.changes(block, scope); }
    catch { console.error('Live layer unavailable; serving the snapshot alone'); return []; }
  }
  private async withLive(snapshot: IndexedSnapshot & { source: Source }, scope: { market?: string } = {}) {
    const overlaid = applyOverlay(snapshot, await this.changesAfter(snapshot.block, scope), scope);
    return { ...overlaid, source: snapshot.source };
  }

  /**
   * Discovery reads the local mirror when it is fresh and The Graph when it is not, so a stopped
   * sync worker costs latency rather than correctness. Nothing a user signs is served from here:
   * quoting, publication, cancellation and redemption all re-read the chain first.
   */
  private async read<T>(fromProjection: () => Promise<T | null>, fromGraph: () => Promise<T>): Promise<T & { source: Source }> {
    if (this.projection) {
      try {
        const mirrored = await fromProjection();
        if (mirrored) return { ...mirrored, source: 'projection' as const };
      } catch { console.error('Market projection unavailable; falling back to The Graph'); }
    }
    return { ...(await fromGraph()), source: 'graph' as const };
  }

  /** Operational visibility for the mirror itself: how far behind it is, and why. */
  async syncStatus() {
    if (!this.projection) return { enabled: false as const };
    const state = await this.projection.freshness();
    return { enabled: true as const, usable: state.usable, ageMs: Number.isFinite(state.ageMs) ? state.ageMs : null,
      indexedBlock: state.checkpoint?.indexedBlock ?? null, status: state.checkpoint?.status ?? 'NEVER_RUN',
      failureCode: state.checkpoint?.failureCode ?? null, syncedAt: state.checkpoint?.syncedAt ?? null,
      markets: state.checkpoint?.markets ?? 0, curves: state.checkpoint?.curves ?? 0 };
  }

  /**
   * `curves` leaves here described one by one, not aggregated: the market page draws each pricing
   * function from its own parameters, and only fixed-price orders belong in a price ladder.
   */
  private decorate(markets: IndexedMarket[]): MarketSummary[] {
    const now = Math.floor(Date.now() / 1000);
    return markets.map(market => ({ ...market, status: status(market, now),
      liquidity: summarize(market.curves), curves: describeCurves(market.curves) }));
  }

  async list() {
    const snapshot = await this.withLive(await this.read(() => this.projection!.indexedMarkets(), () => this.graph.indexedMarkets()));
    return { indexedBlock: snapshot.block, indexedHash: snapshot.hash, liveBlock: snapshot.liveBlock, source: snapshot.source,
      fees: { maker: 0, taker: 0, routing: 0, protocol: 0 }, markets: this.decorate(snapshot.markets) };
  }

  /** Market detail refreshes open status, collateral and result through RPC before display. */
  async detail(market: Address) {
    const snapshot = await this.withLive(await this.read(() => this.projection!.indexedMarket(market), () => this.graph.indexedMarket(market)), { market });
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
    return { indexedBlock: snapshot.block, indexedHash: snapshot.hash, liveBlock: snapshot.liveBlock, source: snapshot.source, fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
      book: buildBook(indexed.curves),
      market: { ...summary!, status: result !== 0 ? 'RESOLVED' : isOpen ? 'OPEN' : 'CLOSED', chainConfirmed: true } };
  }

  /** Holdings come from live token balances, not indexed transfers. */
  async positions(account: Address) {
    const snapshot = await this.withLive(await this.read(() => this.projection!.indexedMarkets(), () => this.graph.indexedMarkets()));
    const markets = snapshot.markets;
    if (markets.length === 0) return { indexedBlock: snapshot.block, source: snapshot.source, positions: [] };
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
    return { indexedBlock: snapshot.block, source: snapshot.source, positions };
  }

  /**
   * A maker's own published curves, including any that were shipped to Aqua but never admitted by
   * the router. Those cannot fill and hold no budget, but they are still the maker's allocation and
   * are still cancellable from here, so they are listed rather than hidden. A fill of an admitted
   * order still depends on the wallet balance its Aqua allocation draws on, which is shared.
   */
  async curvesFor(maker: Address) {
    const base = await this.read(() => this.projection!.curvesByMaker(maker), () => this.graph.curvesByMaker(maker));
    const snapshot = await this.makerWithLive(base, maker);
    const now = Math.floor(Date.now() / 1000);
    return { indexedBlock: snapshot.block, liveBlock: snapshot.liveBlock, source: snapshot.source, curves: snapshot.curves.map(curve => {
      const isYes = (curve.flags & 1) !== 0, isBuy = (curve.flags & 2) !== 0;
      const remaining = curve.maxShares > curve.filled ? curve.maxShares - curve.filled : 0n;
      return {
        orderHash: curve.id, market: curve.market, question: curve.question,
        side: isYes ? 'YES' : 'NO', direction: isBuy ? 'BUY' : 'SELL', shape: curve.flags >> 2,
        startPrice: curve.startPrice, endPrice: curve.endPrice,
        // Equal endpoints never move with the fill, which is what makes them a limit order.
        isLimit: curve.startPrice === curve.endPrice,
        maxShares: curve.maxShares.toString(), filled: curve.filled.toString(), remaining: remaining.toString(),
        active: curve.active, admitted: curve.admitted, publishedAt: curve.publishedAt, closeAt: curve.closeAt,
        outcomeToken: isYes ? curve.yesToken : curve.noToken,
        marketStatus: curve.result !== 0 ? 'RESOLVED' : curve.closeAt <= now ? 'CLOSED' : 'OPEN',
        // Aqua holds the allocation either way, so an unadmitted order can still be withdrawn.
        cancellable: curve.active && remaining > 0n,
        executable: curve.active && curve.admitted && remaining > 0n,
      };
    }) };
  }

  /**
   * A maker's list with newer changes applied. A curve shipped since the snapshot names a market
   * the list may not describe yet; those facts are read once per such market, from the snapshot
   * store, and the curve is listed only when they were found.
   */
  private async makerWithLive(base: { block: number; hash: Hex; curves: MakerCurve[] } & { source: Source }, maker: Address) {
    const changes = await this.changesAfter(base.block, { maker });
    const known = new Set(base.curves.map(curve => curve.market.toLowerCase()));
    const refs = new Map<string, MarketRef>();
    const unseen = [...new Set(changes.map(change => change.market).filter(market => !known.has(market)))].slice(0, 10);
    for (const market of unseen) {
      try {
        const found = (await this.withLive(await this.read(() => this.projection!.indexedMarket(market as Address), () => this.graph.indexedMarket(market as Address)), { market })).markets[0];
        if (found) refs.set(market, { question: found.question, closeAt: found.closeAt, result: found.result, yesToken: found.yesToken, noToken: found.noToken });
      } catch { /* Left out until a later read can describe its market. */ }
    }
    return { ...applyMakerOverlay(base, changes, maker, refs), source: base.source };
  }

  /**
   * Taker routes against one market, newest first, from both sources. A route is one immutable
   * fact keyed by its transaction and log, so the two lists are simply merged and deduplicated —
   * unlike a market or curve change, a trade needs no block comparison to be applied safely. The
   * fills inside a route are neither trades nor volume, so neither source counts them.
   */
  async trades(market: Address, first = 50) {
    let indexedBlock: number | null = null;
    let indexed: OperatorRoute[] = [];
    try {
      const activity = await this.graph.activity(market, first);
      indexedBlock = activity.block;
      indexed = activity.routes;
    } catch { console.error('Graph trade history unavailable; serving live trades alone'); }
    let live: LiveTrade[] = [];
    if (this.live) {
      try { live = await this.live.trades(market, 0, first); }
      catch { console.error('Live trade history unavailable'); }
    }
    const rows = new Map<string, { id: string; market: Address; taker: Address; recipient: Address; isYes: boolean; isBuy: boolean;
      shares: bigint; usdc: bigint; fills: number; transaction: Hex; block: number; final: boolean; source: 'graph' | 'stream' }>();
    for (const route of indexed) rows.set(route.id.toLowerCase(), { id: route.id.toLowerCase(), market: route.market, taker: route.taker, recipient: route.recipient,
      isYes: route.isYes, isBuy: route.isBuy, shares: route.shares, usdc: route.usdc, fills: route.fills, transaction: route.transaction, block: route.block, final: true, source: 'graph' });
    // Both sources present the Subgraph's route id, so a trade the stream saw first and the
    // indexer confirmed later is one row.
    for (const trade of live) if (!rows.has(trade.id.toLowerCase())) rows.set(trade.id.toLowerCase(), trade);
    const trades = [...rows.values()].sort((a, b) => b.block - a.block || a.id.localeCompare(b.id)).slice(0, first);
    return { indexedBlock, liveBlock: live.length ? Math.max(...live.map(trade => trade.block)) : null, trades };
  }

  /**
   * Every order this maker still has admitted in one market, read from the router's own ledger
   * rather than from the indexer. The ledger is the complete list by construction — an order the
   * router has not admitted can never fill — so a stale or unavailable Graph can neither hide an
   * outstanding commitment nor invent one.
   */
  private async openOrders(maker: Address, market: Address, blockNumber: bigint): Promise<OpenOrder[]> {
    const ledger = { address: await this.orderBudget(), abi: orderBudgetAbi, blockNumber } as const;
    const hashes = await this.client.readContract({ ...ledger, functionName: 'openOrders', args: [maker, market] }) as Hex[];
    if (hashes.length === 0) return [];
    type Commitment = { token: Address; owed: bigint; flags: number };
    // Every read is pinned to one block, so the figures below can be compared with each other and
    // with the wallet. The ledger caps a maker at sixteen open orders per market, which bounds this.
    const commitments = await Promise.all(hashes.map(async orderHash => {
      const [commitment, filled] = await Promise.all([
        this.client.readContract({ ...ledger, functionName: 'commitmentOf', args: [orderHash] }) as Promise<Commitment>,
        this.client.readContract({ address: this.config.router, abi: routerAbi, functionName: 'filledShares', args: [orderHash], blockNumber }) as Promise<bigint>,
      ]);
      return { orderHash, filled, ...commitment };
    }));
    // Cancellation lives in Aqua's balance for the order, read at the same block as everything else.
    return Promise.all(commitments.map(async order => {
      const [allocation, tokensCount] = await this.client.readContract({ address: this.config.aqua, abi: aquaAbi,
        functionName: 'rawBalances', args: [maker, this.config.router, order.orderHash, order.token], blockNumber }) as readonly [bigint, number];
      return { ...order, allocation, tokensCount };
    }));
  }

  /**
   * The router deploys its own order ledger and exposes the address, so the two can never disagree
   * and no separate configuration can point at the wrong one. Cached, and re-resolved after a
   * failure rather than remembered as broken.
   */
  private orderBudget(): Promise<Address> {
    this.ledger ??= (this.client.readContract({ address: this.config.router, abi: routerAbi, functionName: 'budget' }) as Promise<Address>)
      .catch(error => { this.ledger = undefined; throw error; });
    return this.ledger;
  }

  /**
   * Refuses rather than assumes. A router without an order ledger, or an RPC that will not answer,
   * means the budget is unknown — and an unknown budget must not be reported as an empty one,
   * which would silently permit exactly what this rule exists to prevent.
   */
  private async commitments(maker: Address, market: Address, blockNumber: bigint): Promise<OpenOrder[]> {
    try {
      return await this.openOrders(maker, market, blockNumber);
    } catch {
      throw new MarketError('order_budget_unavailable', {
        router: this.config.router,
        reason: 'The router did not answer its order-budget ledger. Publication is refused while the '
          + 'per-market commitments of this wallet cannot be established.',
      });
    }
  }

  private static describe(budget: Budget, asset: FundingBudget['asset']): FundingBudget {
    return { ...budget, asset, decimals: 6 };
  }

  /**
   * What one maker may still commit in one market, per funding asset. USDC covers both outcomes
   * because a BUY spends USDC whichever side it names; each outcome token carries its own
   * inventory. Every figure is read at one block so they can be compared with each other.
   */
  async marketBudgets(maker: Address, market: Address): Promise<MarketBudgets> {
    // Never the cached head: a budget read a few seconds behind a fill is exactly the stale check
    // this rule exists to avoid relying on.
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const [registered, isOpen, yesToken, noToken] = await Promise.all([
      this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'isMarket', args: [market], blockNumber }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'isOpen', blockNumber }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'yesToken', blockNumber }),
      this.client.readContract({ address: market, abi: marketAbi, functionName: 'noToken', blockNumber }),
    ]) as [boolean, boolean, Address, Address];
    if (!registered) throw new MarketError('unknown_market');
    const orders = await this.commitments(maker, market, blockNumber);
    const assets = [{ asset: 'USDC' as const, token: this.config.usdc }, { asset: 'YES' as const, token: yesToken },
      { asset: 'NO' as const, token: noToken }];
    const funds = await Promise.all(assets.flatMap(item => [
      this.client.readContract({ address: item.token, abi: erc20Abi, functionName: 'balanceOf', args: [maker], blockNumber }),
      this.client.readContract({ address: item.token, abi: erc20Abi, functionName: 'allowance', args: [maker, this.config.aqua], blockNumber }),
    ]));
    const [usdc, yes, no] = assets.map((item, index) => MarketService.describe(
      budgetOf({ token: item.token, balance: funds[index * 2] as bigint, allowance: funds[index * 2 + 1] as bigint, orders }),
      item.asset));
    return { block: Number(blockNumber), market, maker, spender: this.config.aqua, marketOpen: isOpen,
      usdc: usdc!, yes: yes!, no: no! };
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
   *
   * Publication is two transactions, in this order:
   *
   * 1. `ship` to Aqua, which records the allocation this order may draw on.
   * 2. `admitCurve` on the Horizon router, which is where the per-market budget is enforced and
   *    what makes the order executable at all. Aqua's `ship` has no application callback, so the
   *    router cannot be consulted during step 1 — and an order that stops after step 1 never fills.
   *
   * The figures returned here are advisory: they are read at one block and any of them can move
   * before the maker signs. The refusal that counts happens in step 2, on chain, where two
   * publications racing each other cannot both pass because the second one reads the first.
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
    // A BUY posts a USDC budget and no inventory; a SELL posts inventory and no budget. The BUY
    // figure is the exact curve integral over the whole size, not the opening price times the size,
    // and it is the same figure the router records at admission — so the check below predicts that
    // refusal rather than approximating it.
    const fundingAmount = obligationOf({ ...strategy, filled: 0n });
    const amounts = input.isBuy ? [0n, fundingAmount] : [strategy.maxShares, 0n];
    const fundingToken = input.isBuy ? this.config.usdc : outcome;
    // Never the cached head: a budget read a few seconds behind a fill is exactly the stale check
    // this rule exists to avoid relying on.
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const orders = await this.commitments(input.maker, input.market, blockNumber);
    const [balance, allowance] = await Promise.all([
      this.client.readContract({ address: fundingToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.maker], blockNumber }),
      this.client.readContract({ address: fundingToken, abi: erc20Abi, functionName: 'allowance', args: [input.maker, this.config.aqua], blockNumber }),
    ]) as [bigint, bigint];
    const budget = MarketService.describe(budgetOf({ token: fundingToken, balance, allowance, orders }),
      input.isBuy ? 'USDC' : input.isYes ? 'YES' : 'NO');
    const capacity = checkCapacity(budget, fundingAmount);
    // What this order needs the wallet to hold and Aqua to be allowed to move: itself, plus what
    // this market has already committed. Approving only this order's own amount would leave the
    // admission short and fail on chain.
    const required = budget.committed + fundingAmount;
    const readiness = balance < required ? (budget.committed > 0n ? 'over_budget' : 'insufficient_balance')
      : allowance < required ? 'approval_required' : 'ready';
    return {
      strategy: { ...strategy, maxShares: strategy.maxShares.toString() }, orderHash: keccak256(encoded),
      outcomeToken: outcome, tokens: [outcome, this.config.usdc], amounts: amounts.map(String),
      // Aqua allocations are permissions over a shared wallet balance, not reserved funds.
      shared: input.isBuy ? 'USDC allocations are shared with this wallet’s other markets; a fill elsewhere reduces what remains here.'
        : 'Outcome tokens are bound to this market and outcome and are never reused by another market.',
      readiness,
      budget: { ...budget, block: Number(blockNumber), requested: fundingAmount, required,
        fits: capacity.ok, shortfall: capacity.ok ? 0n : capacity.shortfall },
      approval: { token: fundingToken, spender: this.config.aqua, amount: required.toString() },
      transaction: { to: this.config.aqua, value: '0',
        data: encodeFunctionData({ abi: aquaAbi, functionName: 'ship', args: [this.config.router, encoded, [outcome, this.config.usdc], amounts] }) },
      // Step two, and the only refusal that binds: the router checks this market's budget here.
      admission: { to: this.config.router, value: '0',
        data: encodeFunctionData({ abi: routerAbi, functionName: 'admitCurve', args: [strategy] }) },
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
