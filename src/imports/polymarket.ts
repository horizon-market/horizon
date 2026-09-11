import { z } from 'zod';

/**
 * Polymarket source access.
 *
 * Two rules hold everywhere in this file. The first is that Horizon fetches from one fixed,
 * configured API origin and builds every path itself from a validated slug: a user supplies a
 * Polymarket page address, never a URL to fetch. The second is that only definitions cross the
 * boundary. Polymarket prices, liquidity, volume, order books and settlements are read here so
 * they can be recognised and discarded, and they never become Horizon market data.
 */

/** The official Gamma API. Verified against docs.polymarket.com's OpenAPI on 2026-09-10. */
export const POLYMARKET_API_ORIGIN = 'https://gamma-api.polymarket.com';
export const POLYMARKET_SITE_ORIGIN = 'https://polymarket.com';
const SITE_HOSTS = new Set(['polymarket.com', 'www.polymarket.com']);
/**
 * Sections that put an event behind a category and a league: `/sports/epl/epl-liv-ful-2026-09-12`
 * addresses the same event as `/event/epl-liv-ful-2026-09-12`, which redirects to it. Only shapes
 * verified against the live site are listed; `/politics/<slug>` and `/crypto/<slug>` are not URLs
 * Polymarket serves, and `/sports/<league>` on its own is a listing page, not an event.
 */
const SECTIONS = new Set(['sports']);
/** Slugs are the only user-controlled part of a request path, so they are validated strictly. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,190})$/i;

export class ImportError extends Error {
  constructor(readonly code: string, readonly httpStatus = 422) { super(code); }
}

export type SourceReference = {
  kind: 'event' | 'market';
  /** The slug the reference points at: an event slug, or a market slug. */
  slug: string;
  /** Present when a market URL also names its event, which /event/<event>/<market> does. */
  eventSlug?: string;
  /** The canonical Polymarket page address, rebuilt from the parsed parts. */
  url: string;
};

/**
 * Accepted page shapes, for the error message and for the tests that keep them honest.
 * Verified against polymarket.com on 2026-09-10.
 */
export const SUPPORTED_URL_SHAPES = [
  'https://polymarket.com/event/<event>',
  'https://polymarket.com/event/<event>/<market>',
  'https://polymarket.com/market/<market>',
  'https://polymarket.com/sports/<league>/<event>',
] as const;

/**
 * Accepts the Polymarket page addresses a person can copy from a browser and nothing else.
 * Anything that is not a polymarket.com event or market page is refused before any network
 * call, so a pasted address can never steer the backend at an arbitrary host.
 */
export function parsePolymarketUrl(raw: string): SourceReference {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) throw new ImportError('import_url_invalid', 400);
  let parsed: URL;
  try { parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`); }
  catch { throw new ImportError('import_url_invalid', 400); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ImportError('import_url_invalid', 400);
  if (!SITE_HOSTS.has(parsed.hostname.toLowerCase())) throw new ImportError('import_url_not_polymarket', 400);
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  // Deeper paths are not addresses Polymarket serves, so they are refused rather than trimmed.
  if (segments.length > 3) throw new ImportError('import_url_unsupported_path', 400);
  const [section, first, second] = segments;
  const valid = (value: string | undefined): value is string => Boolean(value && SLUG.test(value));
  // /sports/<league>/<event>: the league is part of the address, and the event slug is the last
  // segment. A league on its own addresses a listing page and is refused.
  if (section && SECTIONS.has(section) && valid(first) && valid(second)) {
    return { kind: 'event', slug: second, url: `${POLYMARKET_SITE_ORIGIN}/${section}/${first}/${second}` };
  }
  if (section === 'event' && valid(first)) {
    // /event/<event-slug>/<market-slug> addresses one child inside its event.
    if (second !== undefined) {
      if (!valid(second)) throw new ImportError('import_url_invalid', 400);
      return { kind: 'market', slug: second, eventSlug: first, url: `${POLYMARKET_SITE_ORIGIN}/event/${first}/${second}` };
    }
    return { kind: 'event', slug: first, url: `${POLYMARKET_SITE_ORIGIN}/event/${first}` };
  }
  if (section === 'market' && valid(first) && second === undefined) {
    return { kind: 'market', slug: first, url: `${POLYMARKET_SITE_ORIGIN}/market/${first}` };
  }
  throw new ImportError('import_url_unsupported_path', 400);
}

export const eventUrl = (slug: string) => `${POLYMARKET_SITE_ORIGIN}/event/${slug}`;
export const marketUrl = (eventSlug: string | undefined, slug: string) =>
  eventSlug ? `${POLYMARKET_SITE_ORIGIN}/event/${eventSlug}/${slug}` : `${POLYMARKET_SITE_ORIGIN}/market/${slug}`;

/**
 * Gamma responses carry well over a hundred fields per market and gain more over time, so these
 * schemas read the fields Horizon needs and tolerate everything else. Types are deliberately
 * loose — Gamma returns numbers, numeric strings and JSON-encoded arrays for the same concepts —
 * and normalisation is what turns them into something Horizon will store.
 */
// Zod 4 treats `unknown` as required unless it is marked optional; Gamma omits fields freely.
const loose = z.unknown().optional();
const text = z.union([z.string(), z.number()]).nullish();
const flag = z.union([z.boolean(), z.string()]).nullish();

export const gammaTagSchema = z.object({ id: text, label: text, slug: text }).loose();
export const gammaMarketSchema = z.object({
  id: text, question: text, conditionId: text, slug: text, description: text, resolutionSource: text,
  outcomes: loose, outcomePrices: loose, clobTokenIds: loose,
  startDate: text, endDate: text, endDateIso: text, startDateIso: text, gameStartTime: text, closedTime: text,
  groupItemTitle: text, groupItemThreshold: text, image: text, icon: text,
  active: flag, closed: flag, archived: flag, restricted: flag, acceptingOrders: flag,
  resolvedBy: text, umaResolutionStatus: text, umaResolutionStatuses: loose, umaBond: text,
  negRisk: flag, negRiskMarketID: text, sportsMarketType: text, marketType: text, line: text,
  tags: z.array(gammaTagSchema).nullish(),
}).loose();
export const gammaEventSchema = z.object({
  id: text, ticker: text, slug: text, title: text, description: text, resolutionSource: text,
  startDate: text, endDate: text, creationDate: text, startTime: text, closedTime: text,
  image: text, icon: text, category: text, subcategory: text,
  active: flag, closed: flag, archived: flag, restricted: flag, negRisk: flag, enableNegRisk: flag,
  negRiskMarketID: text, showAllOutcomes: flag,
  tags: z.array(gammaTagSchema).nullish(),
  series: z.array(z.object({ id: text, slug: text, title: text }).loose()).nullish(),
  markets: z.array(gammaMarketSchema).nullish(),
}).loose();

export type GammaEvent = z.infer<typeof gammaEventSchema>;
export type GammaMarket = z.infer<typeof gammaMarketSchema>;

export type GammaFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The one place that talks to Polymarket. The origin is fixed at construction and every path is
 * built here from an already-validated slug, so no caller can turn this into a general fetcher.
 */
export class GammaClient {
  private readonly origin: string;
  constructor(origin: string = POLYMARKET_API_ORIGIN, private readonly fetchImpl: GammaFetch = fetch, private readonly timeoutMs = 12_000) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new Error('Invalid configuration: POLYMARKET_API_ORIGIN'); }
    if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('Invalid configuration: POLYMARKET_API_ORIGIN must be https');
    }
    this.origin = parsed.origin;
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method: 'GET', headers: { accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new ImportError('import_source_unavailable', 503); }
    if (response.status === 404) throw new ImportError('import_source_not_found', 404);
    if (!response.ok) throw new ImportError('import_source_unavailable', 503);
    try { return await response.json(); }
    catch { throw new ImportError('import_source_unreadable', 502); }
  }

  /** GET /events/slug/{slug}. Some deployments answer with a single object, others with a list. */
  async eventBySlug(slug: string): Promise<GammaEvent> {
    if (!SLUG.test(slug)) throw new ImportError('import_url_invalid', 400);
    const body = await this.get(`/events/slug/${encodeURIComponent(slug)}`);
    const candidate = Array.isArray(body) ? body[0] : body;
    const parsed = gammaEventSchema.safeParse(candidate);
    if (!parsed.success) throw new ImportError('import_source_unreadable', 502);
    return parsed.data;
  }

  /** GET /markets/slug/{slug}. The reply names its event but does not expand the siblings. */
  async marketBySlug(slug: string): Promise<GammaMarket> {
    if (!SLUG.test(slug)) throw new ImportError('import_url_invalid', 400);
    const body = await this.get(`/markets/slug/${encodeURIComponent(slug)}`);
    const candidate = Array.isArray(body) ? body[0] : body;
    const parsed = gammaMarketSchema.safeParse(candidate);
    if (!parsed.success) throw new ImportError('import_source_unreadable', 502);
    return parsed.data;
  }

  /**
   * Resolves either kind of page address to the whole event, because a child is only reviewable
   * next to its siblings: that is what tells a reader whether a selection is exhaustive.
   * A market address also reports which child it pointed at, so only that one is preselected.
   */
  async resolve(reference: SourceReference): Promise<{ event: GammaEvent; focusMarketSlug?: string }> {
    if (reference.kind === 'event') return { event: await this.eventBySlug(reference.slug) };
    const market = await this.marketBySlug(reference.slug);
    const named = reference.eventSlug ?? firstEventSlug(market);
    if (!named) throw new ImportError('import_market_has_no_event', 422);
    const event = await this.eventBySlug(named);
    return { event, focusMarketSlug: reference.slug };
  }
}

function firstEventSlug(market: GammaMarket): string | undefined {
  const events = (market as { events?: unknown }).events;
  if (!Array.isArray(events)) return undefined;
  const slug = (events[0] as { slug?: unknown } | undefined)?.slug;
  return typeof slug === 'string' && SLUG.test(slug) ? slug : undefined;
}
