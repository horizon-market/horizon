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
