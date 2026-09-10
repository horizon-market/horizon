import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { EventService } from './service.js';
import { MarketService } from '../trading/markets.js';
import { GraphError } from '../trading/graph.js';
import { serialize } from '../trading/http.js';

const slugSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/**
 * Read-only event routes. Everything a trader acts on still comes from the market endpoints; these
 * add the grouping, the outcome labels and their order, and the source attribution around them.
 */
export function eventRoutes(events?: EventService, markets?: MarketService) {
  const router = Router();
  if (!events) {
    router.use((_req, res) => res.status(503).json({ error: 'events_not_configured' }));
    return router;
  }
  const reads = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false });

  /** Market state is best-effort here: an indexer outage costs prices, never the grouping itself. */
  const summaries = async () => {
    if (!markets) return { markets: [], indexedBlock: null as number | null, marketsError: 'trading_not_configured' };
    try {
      const listed = await markets.list();
      return { markets: listed.markets, indexedBlock: listed.indexedBlock, marketsError: undefined };
    } catch (error) {
      return { markets: [], indexedBlock: null, marketsError: error instanceof GraphError ? 'graph_unavailable' : 'market_data_unavailable' };
    }
  };

  router.get('/events', reads, async (_req, res) => {
    try {
      const state = await summaries();
      res.json(serialize({
        indexedBlock: state.indexedBlock, marketsError: state.marketsError,
        fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
        events: await events.list(state.markets),
        note: 'Prices, depth, volume and collateral shown against an event are Horizon\'s own. Imported events carry a source attribution and nothing else from their source.',
      }));
    } catch { res.status(503).json({ error: 'event_data_unavailable' }); }
  });

  router.get('/events/:slug', reads, async (req, res) => {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) { res.status(400).json({ error: 'invalid_event' }); return; }
    try {
      const state = await summaries();
      const event = await events.bySlug(slug.data, state.markets);
      if (!event) { res.status(404).json({ error: 'unknown_event' }); return; }
      res.json(serialize({
        indexedBlock: state.indexedBlock, marketsError: state.marketsError,
        fees: { maker: 0, taker: 0, routing: 0, protocol: 0 }, event,
        resolution: {
          enforcement: event.exclusivityEnforcement,
          note: event.exclusivity === 'EXCLUSIVE'
            ? 'The disclosed Horizon resolver settles each market in this group separately. Horizon\'s resolution workflow refuses a second YES while a sibling is already resolved YES or has a YES resolution in flight; the market contracts do not enforce that, so the guarantee is a backend one.'
            : 'Each market in this group is resolved on its own. Nothing requires exactly one of them to resolve YES.',
        },
      }));
    } catch { res.status(503).json({ error: 'event_data_unavailable' }); }
  });

  return router;
}
