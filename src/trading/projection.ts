import type { PrismaClient } from '@prisma/client';
import type { Address, Hex } from 'viem';
import { GraphError, type IndexedCurve, type IndexedMarket, type IndexedSnapshot,
  type MakerCurve, type ProjectedCurve, type ProjectedMarket } from './graph.js';

/** The projection reads only these two sweeps, so tests can drive it with a fake source. */
export type MarketSource = {
  pageMarkets(afterId: string, first: number): Promise<{ block: number; hash: Hex; markets: ProjectedMarket[] }>;
  pageStrategies(afterId: string, first: number): Promise<{ block: number; hash: Hex; curves: ProjectedCurve[] }>;
};
export type SyncOptions = { pageSize?: number; now?: () => Date };
export type SyncReport = { status: 'OK' | 'EMPTY_SNAPSHOT_IGNORED' | 'FAILED'; indexedBlock: number; indexedHash: Hex | '';
  markets: number; curves: number; removedMarkets: number; removedCurves: number; durationMs: number; failureCode?: string };
export const MARKET_CHECKPOINT = 'markets';
const ZERO_ID = '0x';

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const instant = (unix: number) => new Date(unix * 1000);

/** Graph market to storage row. uint256 values become decimal strings; unix seconds become timestamps. */
export const toMarketRow = (market: ProjectedMarket, indexedBlock: number, syncedAt: Date) => ({
  address: market.id.toLowerCase(), creationId: market.creationId, question: market.question, rules: market.rules,
  evidenceSource: market.evidenceSource, closeAt: instant(market.closeAt), resolver: market.resolver.toLowerCase(),
  yesToken: market.yesToken.toLowerCase(), noToken: market.noToken.toLowerCase(), result: market.result,
  resolutionEvidence: market.resolutionEvidence, collateral: market.collateral.toString(),
  createdAt: instant(market.createdAt), indexedBlock, syncedAt,
});
export const toCurveRow = (curve: ProjectedCurve, indexedBlock: number, syncedAt: Date) => ({
  id: curve.id.toLowerCase(), marketAddress: curve.market.toLowerCase(), maker: curve.maker.toLowerCase(), flags: curve.flags,
  startPrice: curve.startPrice, endPrice: curve.endPrice, maxShares: curve.maxShares.toString(), filled: curve.filled.toString(),
  salt: curve.salt, active: curve.active, publishedAt: instant(curve.publishedAt), indexedBlock, syncedAt,
});

type MarketRow = ReturnType<typeof toMarketRow>;
// Storage widens the branded hex types back to plain strings; the inverse mappers re-narrow them.
type CurveRow = Omit<ReturnType<typeof toCurveRow>, 'salt'> & { salt: string };

/** Storage row back to the exact shape the Graph path returns, so callers cannot tell them apart. */
export const fromMarketRow = (row: MarketRow, curves: CurveRow[]): IndexedMarket => ({
  id: row.address as Address, creationId: row.creationId, question: row.question, rules: row.rules,
  evidenceSource: row.evidenceSource, closeAt: seconds(row.closeAt), resolver: row.resolver as Address,
  yesToken: row.yesToken as Address, noToken: row.noToken as Address, result: row.result,
  resolutionEvidence: row.resolutionEvidence, collateral: BigInt(row.collateral), createdAt: seconds(row.createdAt),
  curves: curves.map(fromCurveRow),
});
export const fromCurveRow = (row: CurveRow): IndexedCurve => ({
  id: row.id as Hex, maker: row.maker as Address, filled: BigInt(row.filled),
  strategy: { market: row.marketAddress as Address, flags: row.flags, startPrice: row.startPrice,
    endPrice: row.endPrice, maxShares: BigInt(row.maxShares), salt: row.salt as Hex },
});

/**
 * Reads served from the mirror instead of The Graph. Every method reports the indexed block the
 * mirror is complete through, so a caller's freshness contract is unchanged by the substitution.
 */
export class MarketProjectionStore {
  constructor(private db: PrismaClient, private maxStalenessMs: number) {}

  /** A checkpoint older than the staleness budget is not served; the caller falls back to The Graph. */
  async freshness(now = Date.now()) {
    const checkpoint = await this.db.syncCheckpoint.findUnique({ where: { id: MARKET_CHECKPOINT } });
    if (!checkpoint) return { usable: false as const, ageMs: Infinity, checkpoint: null };
    const ageMs = now - checkpoint.syncedAt.getTime();
    return { usable: ageMs <= this.maxStalenessMs, ageMs, checkpoint };
  }

  private async snapshot(where: { address?: string }): Promise<IndexedSnapshot & { syncedAt: Date } | null> {
    const state = await this.freshness();
    if (!state.usable || !state.checkpoint) return null;
    const rows = await this.db.marketProjection.findMany({
      where: where.address ? { address: where.address } : undefined,
      orderBy: { createdAt: 'desc' }, take: 50, include: { curves: { orderBy: { id: 'asc' } } },
    });
    return { block: state.checkpoint.indexedBlock, hash: state.checkpoint.indexedHash as Hex, syncedAt: state.checkpoint.syncedAt,
      markets: rows.map(row => fromMarketRow(row, row.curves.filter(curve => curve.active))) };
  }

  /** Newest markets with their live curves, or null when the mirror is missing or stale. */
  indexedMarkets() { return this.snapshot({}); }
  indexedMarket(market: Address) { return this.snapshot({ address: market.toLowerCase() }); }

  /** A maker's curves including cancelled and exhausted ones, matching GraphProvider.curvesByMaker. */
  async curvesByMaker(maker: Address, first = 100): Promise<{ block: number; hash: Hex; curves: MakerCurve[] } | null> {
    const state = await this.freshness();
    if (!state.usable || !state.checkpoint) return null;
    const rows = await this.db.curveProjection.findMany({
      where: { maker: maker.toLowerCase() }, orderBy: { publishedAt: 'desc' }, take: first, include: { market: true },
    });
    return { block: state.checkpoint.indexedBlock, hash: state.checkpoint.indexedHash as Hex, curves: rows.map(row => ({
      id: row.id as Hex, maker: row.maker as Address, market: row.marketAddress as Address, question: row.market.question,
      flags: row.flags, startPrice: row.startPrice, endPrice: row.endPrice, maxShares: BigInt(row.maxShares),
      filled: BigInt(row.filled), active: row.active, publishedAt: seconds(row.publishedAt), salt: row.salt as Hex,
      closeAt: seconds(row.market.closeAt), result: row.market.result,
      yesToken: row.market.yesToken as Address, noToken: row.market.noToken as Address,
    })) };
  }
}

async function sweep<T>(page: (after: string, first: number) => Promise<{ block: number; hash: Hex } & Record<string, unknown>>,
  key: string, pageSize: number, id: (item: T) => string) {
  const items: T[] = [];
  let after = ZERO_ID, block = 0, hash = '' as Hex;
  // A page shorter than the request ends the sweep; anything else would loop on a stalled cursor.
  for (let guard = 0; guard < 200; guard++) {
    const result = await page(after, pageSize);
    const batch = result[key] as T[];
    block = block === 0 ? result.block : Math.min(block, result.block);
    hash = result.hash;
    items.push(...batch);
    if (batch.length < pageSize) return { items, block, hash };
    after = id(batch[batch.length - 1]!);
  }
  throw new GraphError('graph_page_limit_exceeded');
}

/**
 * Rebuilds the mirror from a complete Graph sweep. Indexed entities mutate in place — a fill, a
 * cancellation or a resolution changes a row without changing its createdAt — so reconciling a
 * whole snapshot is what keeps the mirror correct. At this market count it is also cheap, and it
 * makes a reorg self-healing: the next sweep simply overwrites whatever the reorg changed.
 */
export async function syncMarkets(db: PrismaClient, source: MarketSource, options: SyncOptions = {}): Promise<SyncReport> {
  const pageSize = options.pageSize ?? 200;
  const startedAt = Date.now();
  const syncedAt = options.now?.() ?? new Date();
  try {
    const markets = await sweep<ProjectedMarket>((after, first) => source.pageMarkets(after, first), 'markets', pageSize, m => m.id);
    const curves = await sweep<ProjectedCurve>((after, first) => source.pageStrategies(after, first), 'curves', pageSize, c => c.id);
    // The block is the older of the two sweeps: the mirror is only complete through the earlier one.
    const indexedBlock = Math.min(markets.block, curves.block);
    const existing = await db.marketProjection.count();
    // An empty sweep against a non-empty mirror is far more likely a broken query than a wiped
    // subgraph. Keep what we have, flag it, and let the next sweep decide.
    if (markets.items.length === 0 && existing > 0) {
      const report: SyncReport = { status: 'EMPTY_SNAPSHOT_IGNORED', indexedBlock, indexedHash: markets.hash,
        markets: 0, curves: 0, removedMarkets: 0, removedCurves: 0, durationMs: Date.now() - startedAt,
        failureCode: 'empty_snapshot' };
      await writeCheckpoint(db, report, syncedAt, false);
      return report;
    }
    const marketRows = markets.items.map(market => toMarketRow(market, indexedBlock, syncedAt));
    const known = new Set(marketRows.map(row => row.address));
    // A curve whose market is missing from this sweep has no row to hang off; the next sweep takes it.
    const curveRows = curves.items.map(curve => toCurveRow(curve, indexedBlock, syncedAt)).filter(row => known.has(row.marketAddress));

    const removed = await db.$transaction(async tx => {
      for (const row of marketRows) {
        const { address, ...rest } = row;
        await tx.marketProjection.upsert({ where: { address }, create: row, update: rest });
      }
      for (const row of curveRows) {
        const { id, ...rest } = row;
        await tx.curveProjection.upsert({ where: { id }, create: row, update: rest });
      }
      const removedCurves = await tx.curveProjection.deleteMany({ where: { id: { notIn: curveRows.map(row => row.id) } } });
      const removedMarkets = await tx.marketProjection.deleteMany({ where: { address: { notIn: marketRows.map(row => row.address) } } });
      return { markets: removedMarkets.count, curves: removedCurves.count };
    }, { timeout: 30_000 });

    const report: SyncReport = { status: 'OK', indexedBlock, indexedHash: markets.hash, markets: marketRows.length,
      curves: curveRows.length, removedMarkets: removed.markets, removedCurves: removed.curves, durationMs: Date.now() - startedAt };
    await writeCheckpoint(db, report, syncedAt, true);
    return report;
  } catch (error) {
    const failureCode = error instanceof GraphError ? error.message : 'sync_failed';
    const report: SyncReport = { status: 'FAILED', indexedBlock: 0, indexedHash: '', markets: 0, curves: 0,
      removedMarkets: 0, removedCurves: 0, durationMs: Date.now() - startedAt, failureCode };
    // A failed sweep must not refresh syncedAt: staleness is what moves reads back to The Graph.
    await writeCheckpoint(db, report, syncedAt, false);
    throw error;
  }
}

/** `advance` is false for a failed or rejected sweep, which records the attempt without claiming freshness. */
async function writeCheckpoint(db: PrismaClient, report: SyncReport, syncedAt: Date, advance: boolean) {
  const observed = { status: report.status, failureCode: report.failureCode ?? null, durationMs: report.durationMs };
  const fresh = { indexedBlock: report.indexedBlock, indexedHash: report.indexedHash, markets: report.markets, curves: report.curves, syncedAt };
  await db.syncCheckpoint.upsert({
    where: { id: MARKET_CHECKPOINT },
    create: { id: MARKET_CHECKPOINT, ...observed, ...(advance ? fresh : { syncedAt: new Date(0) }) },
    update: advance ? { ...observed, ...fresh } : observed,
  });
}
