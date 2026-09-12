import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import type { IndexedCurve, IndexedMarket, IndexedSnapshot, MakerCurve } from './graph.js';

/**
 * The live layer over a snapshot. The Graph, and the mirror rebuilt from it, are complete through
 * one block; the stream consumer records what happened after that block as changes keyed by the
 * entity they touch. Reads apply the changes newer than their snapshot on top of it, so a market
 * created or a curve filled seconds ago is visible without waiting for the indexer — and without
 * ever writing into the tables the sync sweep owns and prunes.
 */
export type OverlayChange = {
  entity: string; key: string; kind: string; market: string; maker: string | null; payload: unknown;
  blockNumber: number; logIndex: number; retiredAt: Date | null;
};
export type Overlaid<T> = T & { liveBlock: number | null };

const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const decimal = z.string().regex(/^\d+$/);
/** A full market from MarketCreated, or a patch from CollateralChanged / MarketResolved. */
export const marketPayloadSchema = z.object({
  creationId: z.string(), question: z.string(), rules: z.string(), evidenceSource: z.string(), closeAt: z.number().int(),
  resolver: address, yesToken: address, noToken: address, result: z.number().int().min(0).max(3), resolutionEvidence: z.string(),
  collateral: decimal, createdAt: z.number().int(),
}).partial();
/** A full curve from Shipped, or a patch from CurveFilled / StrategyAdmitted / Docked. */
export const curvePayloadSchema = z.object({
  market: address, maker: address, flags: z.number().int().min(0).max(15), startPrice: z.number().int(), endPrice: z.number().int(),
  maxShares: decimal, salt: hash, filled: decimal, active: z.boolean(), admitted: z.boolean(), publishedAt: z.number().int(),
}).partial();
export type MarketPayload = z.infer<typeof marketPayloadSchema>;
export type CurvePayload = z.infer<typeof curvePayloadSchema>;

type CurveState = {
  id: Hex; market?: Address; maker?: Address; flags?: number; startPrice?: number; endPrice?: number; maxShares?: bigint; salt?: Hex;
  filled: bigint; active: boolean; admitted: boolean; publishedAt?: number;
};
const fromIndexed = (curve: IndexedCurve, admitted: boolean): CurveState => ({
  id: curve.id, market: curve.strategy.market, maker: curve.maker, flags: curve.strategy.flags, startPrice: curve.strategy.startPrice,
  endPrice: curve.strategy.endPrice, maxShares: curve.strategy.maxShares, salt: curve.strategy.salt, filled: curve.filled,
  // Anything the snapshot carries is shipped and not docked; only its depth is also admitted.
  active: true, admitted,
});
const patchCurve = (state: CurveState, patch: CurvePayload): CurveState => ({
  ...state,
  market: (patch.market as Address | undefined) ?? state.market, maker: (patch.maker as Address | undefined) ?? state.maker,
  flags: patch.flags ?? state.flags, startPrice: patch.startPrice ?? state.startPrice, endPrice: patch.endPrice ?? state.endPrice,
  maxShares: patch.maxShares !== undefined ? BigInt(patch.maxShares) : state.maxShares, salt: (patch.salt as Hex | undefined) ?? state.salt,
  filled: patch.filled !== undefined ? BigInt(patch.filled) : state.filled,
  active: patch.active ?? state.active, admitted: patch.admitted ?? state.admitted, publishedAt: patch.publishedAt ?? state.publishedAt,
});
const complete = (state: CurveState): state is Required<CurveState> =>
  state.market !== undefined && state.maker !== undefined && state.flags !== undefined && state.startPrice !== undefined
  && state.endPrice !== undefined && state.maxShares !== undefined && state.salt !== undefined;
/** Executable depth: shipped, admitted, and not yet exhausted. The same rule the snapshot applies. */
const executable = (state: CurveState) => complete(state) && state.active && state.admitted && state.filled < state.maxShares;

const newest = (changes: OverlayChange[]) => changes.length ? Math.max(...changes.map(change => change.blockNumber)) : null;
/** Only changes the snapshot cannot already contain apply: newer than its block and not retired by a sweep. */
export const applicable = (block: number, changes: OverlayChange[]) => changes
  .filter(change => change.blockNumber > block && !change.retiredAt)
  .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

/**
 * A snapshot with every newer change applied. The result has exactly the shape of a Graph read,
 * so nothing downstream can tell whether a market came from the indexer or from the stream.
 */
export function applyOverlay(snapshot: IndexedSnapshot, changes: OverlayChange[], scope: { market?: string } = {}): Overlaid<IndexedSnapshot> {
  // What the snapshot knew but did not list is consumed here; the result lists depth only.
  const { unadmitted = [], ...base } = snapshot;
  const pending = applicable(base.block, changes);
  if (pending.length === 0) return { ...base, liveBlock: null };
  const markets = new Map<string, Omit<IndexedMarket, 'curves'>>();
  const order: string[] = [];
  const curves = new Map<string, CurveState>();
  // A curve shipped before the snapshot and admitted after it: the admission is a patch with no
  // terms of its own, so the terms are seeded from the snapshot for the patch to complete.
  for (const curve of unadmitted) curves.set(curve.id.toLowerCase(), fromIndexed(curve, false));
  for (const market of base.markets) {
    const { curves: depth, ...rest } = market;
    markets.set(market.id.toLowerCase(), { ...rest, id: market.id.toLowerCase() as Address });
    order.push(market.id.toLowerCase());
    for (const curve of depth) curves.set(curve.id.toLowerCase(), fromIndexed(curve, true));
  }
  const added: string[] = [];
  for (const change of pending) {
    if (change.entity === 'market') {
      const patch = marketPayloadSchema.safeParse(change.payload);
      if (!patch.success) continue;
      const key = change.key.toLowerCase();
      const existing = markets.get(key);
      if (existing) {
        markets.set(key, { ...existing, result: patch.data.result ?? existing.result,
          resolutionEvidence: patch.data.resolutionEvidence ?? existing.resolutionEvidence,
          collateral: patch.data.collateral !== undefined ? BigInt(patch.data.collateral) : existing.collateral });
      } else if (patch.data.question !== undefined && patch.data.yesToken && patch.data.noToken && patch.data.resolver) {
        if (scope.market && scope.market.toLowerCase() !== key) continue;
        markets.set(key, {
          id: key as Address, creationId: patch.data.creationId ?? '', question: patch.data.question, rules: patch.data.rules ?? '',
          evidenceSource: patch.data.evidenceSource ?? '', closeAt: patch.data.closeAt ?? 0, resolver: patch.data.resolver as Address,
          yesToken: patch.data.yesToken as Address, noToken: patch.data.noToken as Address, result: patch.data.result ?? 0,
          resolutionEvidence: patch.data.resolutionEvidence ?? '', collateral: BigInt(patch.data.collateral ?? '0'),
          createdAt: patch.data.createdAt ?? 0,
        });
        added.push(key);
      }
    } else if (change.entity === 'curve') {
      const patch = curvePayloadSchema.safeParse(change.payload);
      if (!patch.success) continue;
      const key = change.key.toLowerCase();
      curves.set(key, patchCurve(curves.get(key) ?? { id: key as Hex, filled: 0n, active: false, admitted: false }, patch.data));
    }
  }
  // A market created after the snapshot is newer than anything in it; the list is newest first.
  const ids = [...added.reverse(), ...order];
  const depthOf = (market: string): IndexedCurve[] => [...curves.values()]
    .filter(state => state.market === market && executable(state))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50)
    .map(state => ({ id: state.id, maker: state.maker!, filled: state.filled, strategy: {
      market: state.market!, flags: state.flags!, startPrice: state.startPrice!, endPrice: state.endPrice!, maxShares: state.maxShares!, salt: state.salt! } }));
  return { block: base.block, hash: base.hash, liveBlock: newest(pending),
    markets: ids.map(id => ({ ...markets.get(id)!, curves: depthOf(id) })) };
}

/** Market facts a maker's curve list shows beside each order; looked up for curves the snapshot lacks. */
export type MarketRef = { question: string; closeAt: number; result: number; yesToken: Address; noToken: Address };

/**
 * A maker's own curves with newer changes applied, cancelled and exhausted ones included. A curve
 * shipped after the snapshot needs its market's facts to be listed; without them it is left out
 * until the next read rather than shown half-described.
 */
export function applyMakerOverlay(base: { block: number; hash: Hex; curves: MakerCurve[] }, changes: OverlayChange[], maker: Address,
  markets: Map<string, MarketRef>): Overlaid<{ block: number; hash: Hex; curves: MakerCurve[] }> {
  const pending = applicable(base.block, changes).filter(change => change.entity === 'curve');
  if (pending.length === 0) return { ...base, liveBlock: null };
  const own = maker.toLowerCase();
  const states = new Map<string, MakerCurve>();
  for (const curve of base.curves) states.set(curve.id.toLowerCase(), curve);
  const partial = new Map<string, CurveState>();
  for (const change of pending) {
    const patch = curvePayloadSchema.safeParse(change.payload);
    if (!patch.success) continue;
    const key = change.key.toLowerCase();
    const existing = states.get(key);
    if (existing) {
      states.set(key, { ...existing, filled: patch.data.filled !== undefined ? BigInt(patch.data.filled) : existing.filled,
        active: patch.data.active ?? existing.active, admitted: patch.data.admitted ?? existing.admitted });
      continue;
    }
    if ((change.maker ?? patch.data.maker)?.toLowerCase() !== own) continue;
    partial.set(key, patchCurve(partial.get(key) ?? { id: key as Hex, filled: 0n, active: false, admitted: false }, patch.data));
  }
  for (const state of partial.values()) {
    const ref = state.market ? markets.get(state.market.toLowerCase()) : undefined;
    if (!complete(state) || !ref) continue;
    states.set(state.id, { id: state.id, maker: state.maker, market: state.market, question: ref.question, flags: state.flags,
      startPrice: state.startPrice, endPrice: state.endPrice, maxShares: state.maxShares, filled: state.filled, active: state.active,
      admitted: state.admitted, publishedAt: state.publishedAt ?? 0, salt: state.salt, closeAt: ref.closeAt, result: ref.result,
      yesToken: ref.yesToken, noToken: ref.noToken });
  }
  return { block: base.block, hash: base.hash, liveBlock: newest(pending),
    curves: [...states.values()].sort((a, b) => b.publishedAt - a.publishedAt) };
}

/**
 * The Subgraph's identity for a route: the transaction hash followed by the log index as four
 * little-endian bytes (graph-ts `concatI32`). Computed here so a stream trade and the indexed
 * route it becomes are the same row to a reader.
 */
export const routeId = (txHash: string, logIndex: number): Hex => {
  const le = Buffer.alloc(4);
  le.writeInt32LE(logIndex);
  return `${txHash.toLowerCase()}${le.toString('hex')}` as Hex;
};

export type LiveTrade = {
  id: string; market: Address; taker: Address; recipient: Address; isYes: boolean; isBuy: boolean;
  shares: bigint; usdc: bigint; fills: number; transaction: Hex; block: number; final: boolean; source: 'stream' | 'graph';
};

/** Reads of the live layer. Every method takes the snapshot block so only newer changes come back. */
export class LiveStore {
  constructor(private db: PrismaClient) {}

  async changes(after: number, scope: { market?: string; maker?: string } = {}): Promise<OverlayChange[]> {
    const rows = await this.db.liveChange.findMany({
      where: { blockNumber: { gt: after }, retiredAt: null,
        ...(scope.market ? { market: scope.market.toLowerCase() } : {}),
        ...(scope.maker ? { maker: scope.maker.toLowerCase(), entity: 'curve' } : {}) },
      orderBy: [{ blockNumber: 'asc' }, { logIndex: 'asc' }], take: 2_000,
    });
    return rows.map(row => ({ entity: row.entity, key: row.key, kind: row.kind, market: row.market, maker: row.maker,
      payload: row.payload, blockNumber: row.blockNumber, logIndex: row.logIndex, retiredAt: row.retiredAt }));
  }

  /** Routes the stream saw after `after`, newest first. Reverted ones never leave the table. */
  async trades(market: string, after: number, first = 50): Promise<LiveTrade[]> {
    const rows = await this.db.trade.findMany({
      where: { market: market.toLowerCase(), blockNumber: { gt: after }, revertedAt: null },
      orderBy: [{ blockNumber: 'desc' }, { id: 'desc' }], take: first,
    });
    return rows.map(row => ({ id: routeId(row.txHash, Number(row.id.split(':')[1] ?? 0)), market: row.market as Address, taker: row.taker as Address,
      recipient: row.recipient as Address, isYes: row.isYes, isBuy: row.isBuy, shares: BigInt(row.shares), usdc: BigInt(row.usdc), fills: row.fills,
      transaction: row.txHash as Hex, block: row.blockNumber, final: row.final, source: 'stream' as const }));
  }

  /** The last block the consumer committed, or null when no stream has ever run. */
  async liveBlock(): Promise<{ blockNumber: number; finalBlock: number; updatedAt: Date } | null> {
    const row = await this.db.streamCheckpoint.findFirst({ orderBy: { updatedAt: 'desc' } });
    return row ? { blockNumber: row.blockNumber, finalBlock: row.finalBlock, updatedAt: row.updatedAt } : null;
  }
}
