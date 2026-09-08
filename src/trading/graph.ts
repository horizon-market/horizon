import { z } from 'zod';
import type { Address, Hex } from 'viem';
import type { Curve } from './math.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const integer = z.string().regex(/^\d+$/);
const strategySchema = z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{64}$/), maker: address, market: z.object({ id: address }),
  flags: z.number().int().min(4).max(15), startPrice: integer, endPrice: integer, maxShares: integer,
  salt: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });
export type Discovered = { id: Hex; maker: Address; strategy: Curve };
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
}
