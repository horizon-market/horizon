import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AuditService, auditFailure } from './service.js';
import { address, serialize } from '../trading/http.js';

const slugSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

/**
 * The public audit trail, read by the identifiers a third party actually holds: an event's slug or
 * a market's address. No token: nothing here is beyond what is already on the Hedera topic, and a
 * trail that only its requester can read is not a public one.
 */
export function auditRoutes(audit: AuditService) {
  const router = Router();
  const reads = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });
  // `?verify=1` reads every published statement back from the mirror node, one request each, so
  // it gets its own, tighter budget than a plain read — the same shape as the import previews.
  const verifies = rateLimit({
    windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    skip: req => req.query.verify !== '1',
  });
  const fail = (res: Response, error: unknown) => {
    console.error('Audit trail read failed', auditFailure(error));
    res.status(503).json({ error: 'audit_unavailable' });
  };
  const view = async (events: Awaited<ReturnType<AuditService['trail']>>, req: Request) => {
    const presented = audit.present(events);
    return req.query.verify === '1' ? { ...presented, verification: await audit.verify(events) } : presented;
  };

  router.get('/events/:slug', reads, verifies, async (req, res) => {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) { res.status(400).json({ error: 'invalid_event' }); return; }
    try {
      const found = await audit.trailForEvent(slug.data);
      if (!found) { res.status(404).json({ error: 'unknown_event' }); return; }
      res.json(serialize({ event: found.event, requests: found.requests, audit: await view(found.events, req) }));
    } catch (error) { fail(res, error); }
  });

  router.get('/markets/:market', reads, verifies, async (req, res) => {
    const market = address.safeParse(req.params.market);
    if (!market.success) { res.status(400).json({ error: 'invalid_market' }); return; }
    try {
      const found = await audit.trailForMarket(market.data);
      if (!found) { res.status(404).json({ error: 'unknown_market' }); return; }
      res.json(serialize({ market: found.market, request: found.request, event: found.event, audit: await view(found.events, req) }));
    } catch (error) { fail(res, error); }
  });

  return router;
}
