import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Address } from 'viem';
import { QuoteService, type TradingConfig } from './service.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v as Address);
const schema = z.object({ market: address, account: address, recipient: address, isYes: z.boolean(), isBuy: z.boolean(),
  shares: z.string().regex(/^\d{1,16}$/).transform(BigInt).refine(v => v >= 1_000_000n && v <= 10n ** 15n),
  slippageBps: z.number().int().min(0).max(1000).default(50) }).strict();
const serialize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
export function tradingRoutes(config?: TradingConfig) {
  const router = Router();
  const service = config ? new QuoteService(config) : undefined;
  let activeQuotes = 0;
  router.use(rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }));
  router.get('/markets', async (_req, res) => {
    if (!service) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    try { res.json(await service.graph.markets()); } catch { res.status(503).json({ error: 'graph_unavailable' }); }
  });
  router.post('/quotes', async (req, res) => {
    if (!service) { res.status(503).json({ error: 'trading_not_configured' }); return; }
    const input = schema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_quote_request' }); return; }
    if (activeQuotes >= 2) { res.status(429).json({ error: 'quote_capacity' }); return; }
    activeQuotes++;
    try { res.json(serialize(await service.quote(input.data))); }
    catch { res.status(409).json({ error: 'quote_unavailable_refresh_or_check_liquidity' }); }
    finally { activeQuotes--; }
  });
  return router;
}
