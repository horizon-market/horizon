import { z } from 'zod';
import type { Address, Hex } from 'viem';
import type { Curve } from './math.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const integer = z.string().regex(/^\d+$/);
const strategySchema = z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/), maker: address, market: z.object({ id: address }),
  flags: z.number().int().min(4).max(15), startPrice: integer, endPrice: integer, maxShares: integer,
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
export type Discovered = { id: Hex; maker: Address; strategy: Curve };
const MARKET_FIELDS = `id creationId question rules evidenceSource closeAt resolver yesToken noToken result resolutionEvidence collateral createdAt
        strategies(first: 50, where: { active: true }, orderBy: id) { id maker flags startPrice endPrice maxShares salt filled }`;
const marketSchema = z.object({
  id: address, creationId: z.string(), question: z.string().max(400), rules: z.string().max(4000),
  evidenceSource: z.string().max(1000), closeAt: integer, resolver: address, yesToken: address, noToken: address,
  result: z.number().int().min(0).max(3), resolutionEvidence: z.string().max(2000), collateral: integer, createdAt: integer,
  strategies: z.array(strategySchema.omit({ market: true }).extend({ filled: integer })).max(50),
});
const snapshotSchema = z.object({
  _meta: z.object({ block: z.object({ number: z.number().int(), hash: z.string() }), hasIndexingErrors: z.boolean() }),
  markets: z.array(marketSchema).max(50),
});
export type IndexedCurve = { id: Hex; maker: Address; strategy: Curve; filled: bigint };
export type IndexedMarket = {
  id: Address; creationId: string; question: string; rules: string; evidenceSource: string; closeAt: number;
  resolver: Address; yesToken: Address; noToken: Address; result: number; resolutionEvidence: string;
  collateral: bigint; createdAt: number; curves: IndexedCurve[];
};
export type IndexedSnapshot = { block: number; hash: Hex; markets: IndexedMarket[] };
const marketRef = z.object({ id: address, question: z.string().max(400) });
const activitySchema = z.object({
  _meta: z.object({ block: z.object({ number: z.number().int(), hash: z.string() }), hasIndexingErrors: z.boolean() }),
  strategies: z.array(strategySchema.extend({ market: marketRef, filled: integer, active: z.boolean(), publishedAt: integer })).max(200),
  fills: z.array(z.object({ id: z.string(), shares: integer, usdc: integer, block: integer, transaction: z.string(),
    strategy: z.object({ id: z.string(), maker: address, flags: z.number().int().min(0).max(15), market: marketRef }) })).max(200),
  routes: z.array(z.object({ id: z.string(), taker: address, recipient: address, isYes: z.boolean(), isBuy: z.boolean(),
    shares: integer, usdc: integer, fills: integer, transaction: z.string(), block: integer, market: marketRef })).max(200),
});
export type OperatorCurve = { id: Hex; maker: Address; market: Address; question: string; flags: number;
  startPrice: number; endPrice: number; maxShares: bigint; filled: bigint; active: boolean; publishedAt: number; salt: Hex };
export type OperatorFill = { id: Hex; strategy: Hex; maker: Address; flags: number; market: Address; question: string;
  shares: bigint; usdc: bigint; block: number; transaction: Hex };
export type OperatorRoute = { id: Hex; market: Address; question: string; taker: Address; recipient: Address;
  isYes: boolean; isBuy: boolean; shares: bigint; usdc: bigint; fills: number; transaction: Hex; block: number };
export type IndexedActivity = { block: number; hash: Hex; curves: OperatorCurve[]; fills: OperatorFill[]; routes: OperatorRoute[] };
const makerMarketRef = z.object({ id: address, question: z.string().max(400), closeAt: integer,
  result: z.number().int().min(0).max(3), yesToken: address, noToken: address });
const makerCurvesSchema = z.object({
  _meta: z.object({ block: z.object({ number: z.number().int(), hash: z.string() }), hasIndexingErrors: z.boolean() }),
  strategies: z.array(strategySchema.extend({ market: makerMarketRef, filled: integer, active: z.boolean(), publishedAt: integer })).max(100),
});
export type MakerCurve = OperatorCurve & { closeAt: number; result: number; yesToken: Address; noToken: Address };
function toSnapshot(data: z.infer<typeof snapshotSchema>): IndexedSnapshot {
  if (data._meta.hasIndexingErrors) throw new GraphError('graph_indexing_errors');
  return { block: data._meta.block.number, hash: data._meta.block.hash as Hex, markets: data.markets.map(market => ({
    id: market.id as Address, creationId: market.creationId, question: market.question, rules: market.rules,
    evidenceSource: market.evidenceSource, closeAt: Number(market.closeAt), resolver: market.resolver as Address,
    yesToken: market.yesToken as Address, noToken: market.noToken as Address, result: market.result,
    resolutionEvidence: market.resolutionEvidence, collateral: BigInt(market.collateral), createdAt: Number(market.createdAt),
    curves: market.strategies.map(strategy => ({ id: strategy.id as Hex, maker: strategy.maker as Address, filled: BigInt(strategy.filled),
      strategy: { market: market.id as Address, flags: strategy.flags, startPrice: Number(strategy.startPrice),
        endPrice: Number(strategy.endPrice), maxShares: BigInt(strategy.maxShares), salt: strategy.salt as Hex } })),
  })) };
}
export class GraphError extends Error {}

export class GraphProvider {
  constructor(private url: string, private apiKey?: string) {}
  async query(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    try {
      const response = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ query, variables }) });
      if (!response.ok) throw new GraphError('graph_unavailable');
      const reply = await response.json() as { data?: unknown; errors?: unknown };
      if (reply.errors || !reply.data) throw new GraphError('graph_query_failed');
      return reply.data;
    } catch { throw new GraphError('graph_unavailable'); }
  }
  async candidates(market: Address): Promise<{ block: number; hash: Hex; candidates: Discovered[] }> {
    const data = z.object({ _meta: z.object({ block: z.object({ number: z.number().int(), hash: z.string() }), hasIndexingErrors: z.boolean() }), strategies: z.array(strategySchema).max(32) })
      .parse(await this.query(`query Candidates($market: Bytes!) {
        _meta { block { number hash } hasIndexingErrors }
        strategies(first: 32, orderBy: id, where: { market: $market, active: true }) {
          id maker market { id } flags startPrice endPrice maxShares salt
        }
      }`, { market: market.toLowerCase() }));
    if (data._meta.hasIndexingErrors) throw new GraphError('graph_indexing_errors');
    return { block: data._meta.block.number, hash: data._meta.block.hash as Hex,
      candidates: data.strategies.map(s => ({ id: s.id as Hex, maker: s.maker as Address, strategy: {
        market: s.market.id as Address, flags: s.flags, startPrice: Number(s.startPrice), endPrice: Number(s.endPrice), maxShares: BigInt(s.maxShares), salt: s.salt as Hex,
      } })) };
  }
  /**
   * Operator view of one market or of every market: published curves including cancelled and
   * exhausted ones, the individual fills against them, and the taker routes that produced them.
   */
  async activity(market?: Address, first = 50): Promise<IndexedActivity> {
    const scoped = Boolean(market);
    const declaration = scoped ? '($first: Int!, $market: Bytes!)' : '($first: Int!)';
    const byMarket = scoped ? ', where: { market: $market }' : '';
    const byStrategyMarket = scoped ? ', where: { strategy_: { market: $market } }' : '';
    const data = activitySchema.parse(await this.query(`query Activity${declaration} {
      _meta { block { number hash } hasIndexingErrors }
      strategies(first: $first, orderBy: publishedAt, orderDirection: desc${byMarket}) {
        id maker flags startPrice endPrice maxShares salt filled active publishedAt market { id question }
      }
      fills(first: $first, orderBy: block, orderDirection: desc${byStrategyMarket}) {
        id shares usdc block transaction strategy { id maker flags market { id question } }
      }
      routes(first: $first, orderBy: block, orderDirection: desc${byMarket}) {
        id taker recipient isYes isBuy shares usdc fills transaction block market { id question }
      }
    }`, scoped ? { first, market: market!.toLowerCase() } : { first }));
    if (data._meta.hasIndexingErrors) throw new GraphError('graph_indexing_errors');
    return {
      block: data._meta.block.number, hash: data._meta.block.hash as Hex,
      curves: data.strategies.map(strategy => ({
        id: strategy.id as Hex, maker: strategy.maker as Address, market: strategy.market.id as Address,
        question: strategy.market.question, flags: strategy.flags, startPrice: Number(strategy.startPrice),
        endPrice: Number(strategy.endPrice), maxShares: BigInt(strategy.maxShares), filled: BigInt(strategy.filled),
        active: strategy.active, publishedAt: Number(strategy.publishedAt), salt: strategy.salt as Hex,
      })),
      fills: data.fills.map(fill => ({
        id: fill.id as Hex, strategy: fill.strategy.id as Hex, maker: fill.strategy.maker as Address,
        flags: fill.strategy.flags, market: fill.strategy.market.id as Address, question: fill.strategy.market.question,
        shares: BigInt(fill.shares), usdc: BigInt(fill.usdc), block: Number(fill.block), transaction: fill.transaction as Hex,
      })),
      routes: data.routes.map(route => ({
        id: route.id as Hex, market: route.market.id as Address, question: route.market.question,
        taker: route.taker as Address, recipient: route.recipient as Address, isYes: route.isYes, isBuy: route.isBuy,
        shares: BigInt(route.shares), usdc: BigInt(route.usdc), fills: Number(route.fills),
        transaction: route.transaction as Hex, block: Number(route.block),
      })),
    };
  }
  /** Every curve one maker has published, newest first, including cancelled and exhausted ones. */
  async curvesByMaker(maker: Address, first = 100): Promise<{ block: number; hash: Hex; curves: MakerCurve[] }> {
    const data = makerCurvesSchema.parse(await this.query(`query MakerCurves($maker: Bytes!, $first: Int!) {
      _meta { block { number hash } hasIndexingErrors }
      strategies(first: $first, where: { maker: $maker }, orderBy: publishedAt, orderDirection: desc) {
        id maker flags startPrice endPrice maxShares salt filled active publishedAt
        market { id question closeAt result yesToken noToken }
      }
    }`, { maker: maker.toLowerCase(), first }));
    if (data._meta.hasIndexingErrors) throw new GraphError('graph_indexing_errors');
    return { block: data._meta.block.number, hash: data._meta.block.hash as Hex, curves: data.strategies.map(strategy => ({
      id: strategy.id as Hex, maker: strategy.maker as Address, market: strategy.market.id as Address,
      question: strategy.market.question, flags: strategy.flags, startPrice: Number(strategy.startPrice),
      endPrice: Number(strategy.endPrice), maxShares: BigInt(strategy.maxShares), filled: BigInt(strategy.filled),
      active: strategy.active, publishedAt: Number(strategy.publishedAt), salt: strategy.salt as Hex,
      closeAt: Number(strategy.market.closeAt), result: strategy.market.result,
      yesToken: strategy.market.yesToken as Address, noToken: strategy.market.noToken as Address,
    })) };
  }
  async markets() {
    return this.query(`{ _meta { block { number hash } hasIndexingErrors } markets(first: 50, orderBy: createdAt, orderDirection: desc) {
      id question rules evidenceSource closeAt resolver yesToken noToken result collateral createdAt
    } }`);
  }
  /** Typed discovery for the application: markets plus their currently active curves. */
  async indexedMarkets(first = 50): Promise<IndexedSnapshot> {
    const data = snapshotSchema.parse(await this.query(`query Markets($first: Int!) {
      _meta { block { number hash } hasIndexingErrors }
      markets(first: $first, orderBy: createdAt, orderDirection: desc) {
        ${MARKET_FIELDS}
      }
    }`, { first }));
    return toSnapshot(data);
  }
  async indexedMarket(market: Address): Promise<IndexedSnapshot> {
    const data = snapshotSchema.parse(await this.query(`query Market($id: Bytes!) {
      _meta { block { number hash } hasIndexingErrors }
      markets(where: { id: $id }, first: 1) {
        ${MARKET_FIELDS}
      }
    }`, { id: market.toLowerCase() }));
    return toSnapshot(data);
  }
}
