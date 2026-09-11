import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { QuoteService, type TradingConfig } from './service.js';
import { MarketService, MarketError } from './markets.js';
import { GraphError } from './graph.js';
import type { EventService } from '../events/service.js';

export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v as Address);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v as Hex);
const shares = z.string().regex(/^\d{1,16}$/).transform(BigInt);
const quoteSchema = z.object({ market: address, account: address, recipient: address, isYes: z.boolean(), isBuy: z.boolean(),
  shares: shares.refine(v => v >= 1_000_000n && v <= 10n ** 15n),
  slippageBps: z.number().int().min(0).max(1000).default(50) }).strict();
const publishSchema = z.object({ maker: address, market: address, isYes: z.boolean(), isBuy: z.boolean(),
  startPrice: z.number().int().min(1).max(999_999), endPrice: z.number().int().min(1).max(999_999),
  shares: shares.refine(v => v >= 1_000_000n && v <= 10n ** 15n), shape: z.number().int().min(1).max(3), salt: hash.optional() }).strict();
const cancelSchema = z.object({ maker: address, market: address, orderHash: hash, outcomeToken: address }).strict();
const optionalShares = z.string().regex(/^\d{1,16}$/).default('0').transform(BigInt);
const redeemSchema = z.object({ account: address, market: address, recipient: address,
  yesShares: optionalShares, noShares: optionalShares }).strict();

export const serialize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));

function logMarketFailure(error: unknown, operation: string) {
  // Database/RPC error messages may contain credentials; report only diagnostic categories.
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  console.error('Market request failed', {
    operation,
    kind: error instanceof GraphError ? 'graph' : error instanceof z.ZodError ? 'response_validation' : 'internal',
    graphCode: error instanceof GraphError && /^graph_[a-z_]+$/.test(error.message) ? error.message : undefined,
    code: typeof code === 'string' && /^(P\d{4}|[A-Z0-9]{5})$/.test(code) ? code : undefined,
    validationIssues: error instanceof z.ZodError ? error.issues.map(issue => ({ code: issue.code, path: issue.path })) : undefined,
  });
}

/** `service` is the wired MarketService, which knows whether a local mirror is available. */
export function tradingRoutes(config?: TradingConfig, marketService?: MarketService, events?: EventService) {
  const router = Router();
  const service = config ? new QuoteService(config) : undefined;
  const markets = marketService ?? (config ? new MarketService(config) : undefined);
  let activeQuotes = 0;
  const reads = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false });
  const writes = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  // The order ticket prices itself as the trader types, so quoting gets its own budget. Each
  // quote still refreshes chain state and simulates a whole route, and stays concurrency-capped.
  const quotes = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const guard = <T>(res: Parameters<Parameters<Router['get']>[1]>[1], run: () => Promise<T>) => run().then(
    value => res.json(serialize(value)),
    error => {
      if (error instanceof MarketError) {
        const status = error.message === 'unknown_market' ? 404 : error.message === 'order_budget_unavailable' ? 503 : 422;
        res.status(status).json(serialize({ error: error.message, ...error.details }));
        return;
      }
      logMarketFailure(error, 'market');
      if (error instanceof GraphError) { res.status(503).json({ error: 'graph_unavailable' }); return; }
      res.status(503).json({ error: 'market_data_unavailable' });
    });

  // One read, from the mirror when it is fresh. The second, untyped Graph query this used to run
  // alongside it returned the same markets again and set the floor on how fast the page could load.
  router.get('/markets', reads, async (_req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    try {
      const [list, sync] = await Promise.all([markets.list(), markets.syncStatus()]);
      // Grouped markets travel with their event so browsing can draw one card per event and no
      // child twice. `markets` still carries every market, so a client that ignores `events`
      // keeps working exactly as before.
      const grouped = events ? await events.list(list.markets).catch(() => []) : [];
      const inGroup = new Set(grouped.flatMap(event => event.children.map(child => child.marketAddress?.toLowerCase())).filter(Boolean) as string[]);
      res.json(serialize({
        ...list, sync, events: grouped,
        standalone: list.markets.filter(market => !inGroup.has(market.id.toLowerCase())).map(market => market.id),
      }));
    } catch (error) {
      logMarketFailure(error, 'markets.list_or_sync_status');
      res.status(503).json({ error: 'graph_unavailable' });
    }
  });
  router.get('/markets/:market', reads, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const market = address.safeParse(req.params.market);
    if (!market.success) { res.status(400).json({ error: 'invalid_market' }); return; }
    // The market page keeps its own URL and its own trading; the event, when there is one, is
    // context beside it — never a redirect away from a link somebody already holds.
    await guard(res, async () => {
      const detail = await markets.detail(market.data);
      const membership = events ? await events.forMarket(market.data).catch(() => null) : null;
      return {
        ...detail,
        event: membership ? {
          slug: membership.event.slug, title: membership.event.title, exclusivity: membership.event.exclusivity,
          exclusivityNote: membership.event.exclusivityNote, outcomesComplete: membership.event.outcomesComplete,
          exclusivityEnforcement: membership.event.exclusivity === 'EXCLUSIVE' ? 'backend_only' : 'none',
          source: { provider: membership.event.sourceProvider, url: membership.event.sourceUrl, importedAt: membership.event.importedAt },
          outcomeLabel: membership.member.outcomeLabel, position: membership.member.position,
          siblings: membership.event.members.map(member => ({
            position: member.position, outcomeLabel: member.outcomeLabel, marketAddress: member.marketAddress,
          })),
        } : null,
      };
    });
  });
  /** Trade history: indexed routes plus every route the stream has seen since the indexer's block. */
  router.get('/markets/:market/trades', reads, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const market = address.safeParse(req.params.market);
    if (!market.success) { res.status(400).json({ error: 'invalid_market' }); return; }
    await guard(res, () => markets.trades(market.data));
  });
  router.get('/positions/:account', reads, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const account = address.safeParse(req.params.account);
    if (!account.success) { res.status(400).json({ error: 'invalid_account' }); return; }
    await guard(res, () => markets.positions(account.data));
  });
  /**
   * What this maker may still commit in this market, per funding asset. The numbers come from the
   * router's own commitment registry at one block, so they neither depend on the indexer nor
   * reserve anything: they describe the wallet as it stands, and a fill elsewhere can move them.
   */
  router.get('/markets/:market/budgets/:maker', reads, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const market = address.safeParse(req.params.market), maker = address.safeParse(req.params.maker);
    if (!market.success) { res.status(400).json({ error: 'invalid_market' }); return; }
    if (!maker.success) { res.status(400).json({ error: 'invalid_account' }); return; }
    await guard(res, () => markets.marketBudgets(maker.data, market.data));
  });
  router.get('/curves/:maker', reads, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const maker = address.safeParse(req.params.maker);
    if (!maker.success) { res.status(400).json({ error: 'invalid_account' }); return; }
    await guard(res, () => markets.curvesFor(maker.data));
  });
  router.post('/curves', writes, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const input = publishSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_curve_request' }); return; }
    await guard(res, () => markets.preparePublication(input.data));
  });
  router.post('/curves/cancellations', writes, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const input = cancelSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_cancellation_request' }); return; }
    await guard(res, () => markets.prepareCancellation(input.data));
  });
  router.post('/redemptions', writes, async (req, res) => {
    if (!markets) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const input = redeemSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_redemption_request' }); return; }
    await guard(res, () => markets.prepareRedemption(input.data));
  });
  router.post('/quotes', quotes, async (req, res) => {
    if (!service) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const input = quoteSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_quote_request' }); return; }
    if (activeQuotes >= 4) { res.status(429).json({ error: 'quote_capacity' }); return; }
    activeQuotes++;
    try { res.json(serialize(await service.quote(input.data))); }
    catch { res.status(409).json({ error: 'quote_unavailable_refresh_or_check_liquidity' }); }
    finally { activeQuotes--; }
  });
  return router;
}
