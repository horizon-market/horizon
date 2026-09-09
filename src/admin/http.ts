import { Router, type RequestHandler, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { verifyPassword } from '../password.js';
import { WorkflowError } from '../creation/service.js';
import { AdminService, RESOLUTIONS, type ResolutionResult } from './service.js';
import { address, serialize } from '../trading/http.js';
import { MarketError } from '../trading/markets.js';
import { GraphError } from '../trading/graph.js';

declare module 'express-session' {
  interface SessionData { adminEmail?: string }
}

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(1024) }).strict();
const resolutionSchema = z.object({
  market: address, result: z.enum(Object.keys(RESOLUTIONS) as [ResolutionResult, ...ResolutionResult[]]),
  evidence: z.string().trim().min(10).max(2000),
}).strict();
const reconcileSchema = z.object({ outcome: z.enum(['SETTLED', 'FAILED']), reference: z.string().trim().min(3).max(200) }).strict();

/**
 * Minimal authenticated admin API used by the operator screen. It shares the admin credential and
 * session store with AdminJS but exposes only deliberate service actions, each of them audited.
 */
export function adminRoutes(config: Config, service: AdminService, session: RequestHandler) {
  const router = Router();
  router.use(session);
  const authenticated: RequestHandler = (req, res, next) => {
    if (!req.session?.adminEmail) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  };
  // Session-authenticated writes must be JSON, which browsers cannot send cross-origin without CORS.
  const jsonOnly: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return; }
    next();
  };
  const fail = (res: Response, error: unknown) => {
    if (error instanceof WorkflowError) { res.status(error.httpStatus).json({ error: error.code }); return; }
    if (error instanceof MarketError) { res.status(error.message === 'unknown_market' ? 404 : 422).json({ error: error.message }); return; }
    if (error instanceof GraphError) { res.status(503).json({ error: 'graph_unavailable' }); return; }
    console.error('Admin action failed; internal details withheld');
    res.status(500).json({ error: 'internal_error' });
  };
  const actor = (req: Request) => req.session.adminEmail ?? 'unknown';

  router.get('/session', (req, res) => res.json({ authenticated: Boolean(req.session?.adminEmail), email: req.session?.adminEmail ?? null }));
  router.post('/session', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), jsonOnly, async (req, res) => {
    const input = loginSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_credentials' }); return; }
    const valid = await verifyPassword(input.data.password, config.ADMIN_PASSWORD_HASH) && input.data.email === config.ADMIN_EMAIL;
    if (!valid) { res.status(401).json({ error: 'invalid_credentials' }); return; }
    req.session.regenerate(error => {
      if (error) { res.status(500).json({ error: 'session_failed' }); return; }
      req.session.adminEmail = input.data.email;
      res.json({ authenticated: true, email: input.data.email });
    });
  });
  router.delete('/session', (req, res) => req.session.destroy(() => res.json({ authenticated: false })));

  router.get('/overview', authenticated, async (_req, res) => {
    try { res.json(serialize(await service.overview())); } catch (error) { fail(res, error); }
  });
  // Curves, fills and routes, optionally scoped to one market.
  router.get('/activity', authenticated, async (req, res) => {
    const market = req.query.market === undefined ? undefined : address.safeParse(req.query.market);
    if (market && !market.success) { res.status(400).json({ error: 'invalid_market' }); return; }
    try { res.json(serialize(await service.activity(market?.data))); } catch (error) { fail(res, error); }
  });
  router.post('/requests/:id/retry', authenticated, jsonOnly, async (req, res) => {
    try { res.json(serialize(await service.retryCreation(actor(req), req.params.id!))); } catch (error) { fail(res, error); }
  });
  router.post('/payments/:id/reconciliation', authenticated, jsonOnly, async (req, res) => {
    const input = reconcileSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_reconciliation' }); return; }
    try { res.json(serialize(await service.reconcilePayment(actor(req), req.params.id!, input.data.outcome, input.data.reference))); }
    catch (error) { fail(res, error); }
  });
  router.post('/resolutions', authenticated, jsonOnly, async (req, res) => {
    const input = resolutionSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_resolution' }); return; }
    try { res.json(serialize(await service.requestResolution(actor(req), input.data.market, input.data.result, input.data.evidence))); }
    catch (error) { fail(res, error); }
  });
  return router;
}
