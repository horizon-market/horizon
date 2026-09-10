import type { PrismaClient } from '@prisma/client';
import type { Address } from 'viem';
import type { MarketService, MarketSummary } from '../trading/markets.js';

/**
 * Events for browsing and trading.
 *
 * An event is service metadata: a durable grouping, its outcome labels and their order, and where
 * its definitions came from. Everything a trader acts on still comes from the market read path —
 * prices, depth, collateral, status and resolution are Horizon's own indexed and on-chain state.
 * A child with no deployed market yet is reported as pending rather than dressed up as a market.
 */

export type EventChild = {
  position: number;
  outcomeLabel: string;
  question: string;
  marketAddress: string | null;
  /** Horizon market state, present once the child is deployed and indexed. */
  market: MarketSummary | null;
  source: { slug: string | null; url: string | null } | null;
};

export type EventSummary = {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  imageUrl: string | null;
  iconUrl: string | null;
  exclusivity: 'COLLECTION' | 'EXCLUSIVE';
  exclusivityNote: string;
  outcomesComplete: boolean;
  status: string;
  source: {
    provider: string; eventId: string | null; slug: string | null; url: string | null; importedAt: Date | null;
  };
  createdAt: Date;
  children: EventChild[];
  /** Local, Horizon-only statistics. Nothing here comes from an imported source. */
  stats: { markets: number; live: number; open: number; resolved: number; curves: number; collateral: string };
  /**
   * How the exclusivity rule is enforced. `backend_only` is the honest answer: the market
   * contracts hold no notion of a group, so this is a check in the resolution workflow.
   */
  exclusivityEnforcement: 'backend_only' | 'none';
};

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 12) : [];

const EVENT_INCLUDE = { members: { orderBy: { position: 'asc' } } } as const;
type EventRow = { members: { position: number; outcomeLabel: string; question: string; marketAddress: string | null; sourceSlug: string | null; sourceUrl: string | null }[] }
  & { id: string; slug: string; title: string; description: string; category: string; tags: unknown; imageUrl: string | null; iconUrl: string | null;
      exclusivity: string; exclusivityNote: string; outcomesComplete: boolean; status: string; sourceProvider: string;
      sourceEventId: string | null; sourceSlug: string | null; sourceUrl: string | null; importedAt: Date | null; createdAt: Date };

export class EventService {
  constructor(private db: PrismaClient) {}

  /** Only events with at least one deployed child are browsable; a draft is not a product yet. */
  async list(markets: MarketSummary[] = [], take = 50): Promise<EventSummary[]> {
    const rows = await this.db.marketEvent.findMany({
      where: { members: { some: { marketAddress: { not: null } } } },
      orderBy: { createdAt: 'desc' }, take, include: EVENT_INCLUDE,
    });
    const byAddress = new Map(markets.map(market => [market.id.toLowerCase(), market]));
    return rows.map(row => decorate(row, byAddress));
  }

  async bySlug(slug: string, markets: MarketSummary[] = []): Promise<EventSummary | null> {
    const row = await this.db.marketEvent.findUnique({ where: { slug }, include: EVENT_INCLUDE });
    if (!row) return null;
    return decorate(row, new Map(markets.map(market => [market.id.toLowerCase(), market])));
  }

  /**
   * The event one market belongs to, or null when it is standalone. Used by the market page for
   * its group context, and by the resolution workflow to find a market's siblings.
   */
  async forMarket(market: string) {
    const member = await this.db.eventMarket.findFirst({
      // Addresses are written lower-cased; the case-insensitive match keeps a row written by an
      // earlier release, or by hand, from silently dropping its market out of its event.
      where: { marketAddress: { equals: market, mode: 'insensitive' } },
      include: { event: { include: EVENT_INCLUDE } },
    });
    return member ? { member, event: member.event } : null;
  }

  /** Every address that belongs to some event, so browsing never draws a child twice. */
  async groupedAddresses(): Promise<Set<string>> {
    const rows = await this.db.eventMarket.findMany({ where: { marketAddress: { not: null } }, select: { marketAddress: true } });
    return new Set(rows.map(row => row.marketAddress!.toLowerCase()));
  }

  /**
   * Sibling resolution state for an explicitly exclusive event: what is already decided on chain,
   * and what an operator has already asked for but not yet submitted.
   */
  async siblings(eventId: string, exclude: string) {
    const [members, pending] = await Promise.all([
      this.db.eventMarket.findMany({ where: { eventId, marketAddress: { not: null } }, orderBy: { position: 'asc' } }),
      this.db.marketResolution.findMany({ where: { eventId, status: { in: ['PENDING', 'RUNNING', 'SUBMITTED'] } } }),
    ]);
    const skip = exclude.toLowerCase();
    return {
      members: members.filter(member => member.marketAddress!.toLowerCase() !== skip),
      pending: pending.filter(record => record.market.toLowerCase() !== skip),
    };
  }
}

function decorate(row: EventRow, byAddress: Map<string, MarketSummary>): EventSummary {
  const children: EventChild[] = row.members.map(member => ({
    position: member.position, outcomeLabel: member.outcomeLabel, question: member.question,
    marketAddress: member.marketAddress,
    market: member.marketAddress ? byAddress.get(member.marketAddress.toLowerCase()) ?? null : null,
    source: member.sourceUrl || member.sourceSlug ? { slug: member.sourceSlug, url: member.sourceUrl } : null,
  }));
  const live = children.filter(child => child.market);
  const exclusivity = row.exclusivity === 'EXCLUSIVE' ? 'EXCLUSIVE' as const : 'COLLECTION' as const;
  return {
    id: row.id, slug: row.slug, title: row.title, description: row.description, category: row.category,
    tags: asStrings(row.tags), imageUrl: row.imageUrl, iconUrl: row.iconUrl,
    exclusivity, exclusivityNote: row.exclusivityNote, outcomesComplete: row.outcomesComplete, status: row.status,
    source: { provider: row.sourceProvider, eventId: row.sourceEventId, slug: row.sourceSlug, url: row.sourceUrl, importedAt: row.importedAt },
    createdAt: row.createdAt, children,
    stats: {
      markets: children.length, live: live.length,
      open: live.filter(child => child.market!.status === 'OPEN').length,
      resolved: live.filter(child => child.market!.status === 'RESOLVED').length,
      curves: live.reduce((total, child) => total + child.market!.liquidity.curves, 0),
      collateral: live.reduce((total, child) => total + child.market!.collateral, 0n).toString(),
    },
    exclusivityEnforcement: exclusivity === 'EXCLUSIVE' ? 'backend_only' : 'none',
  };
}

/** Convenience for callers that hold a MarketService: list events against a fresh market read. */
export async function listEventsWithMarkets(events: EventService, markets?: MarketService) {
  if (!markets) return { events: await events.list(), grouped: await events.groupedAddresses() };
  const listed = await markets.list();
  return { events: await events.list(listed.markets), grouped: await events.groupedAddresses(), listed };
}

export type { Address };
