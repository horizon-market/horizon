import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import AdminJS from 'adminjs';
import AdminJSExpress from '@adminjs/express';
import { Database, Resource, getModelByName } from '@adminjs/prisma';
import { rateLimit } from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { verifyPassword } from './password.js';
import { tradingRoutes } from './trading/http.js';
import { creationRoutes } from './creation/http.js';
import { adminRoutes } from './admin/http.js';
import { buildServices, publicConfig, type QueueBindings } from './services.js';

AdminJS.registerAdapter({ Database, Resource });

const WEB_DIST = resolve('web/dist');

export async function createApp(config: Config, db: PrismaClient, queue: QueueBindings = {}) {
  const app = express();
  const services = buildServices(config, db, queue);
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  // The API serves the built frontend from its own origin; the Vite dev server runs on another one.
  // Credentialed requests need an exact allowed origin, and every other origin is refused.
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (!origin || origin === `${req.protocol}://${req.get('host')}`) { next(); return; }
    if (origin !== config.WEB_ORIGIN) { res.status(403).json({ error: 'origin_not_allowed' }); return; }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, idempotency-key, payment-signature, x-payment');
    res.setHeader('access-control-expose-headers', 'payment-required, payment-response, x-payment-response');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  const pool = new Pool({ connectionString: config.DATABASE_URL, application_name: 'horizon-admin-sessions' });
  pool.on('error', () => console.error('Admin session database unavailable'));
  const Store = connectPgSimple(session);
  const store = new Store({ pool, tableName: 'AdminSession', createTableIfMissing: false });
  const sessionOptions: session.SessionOptions = {
    store, secret: config.SESSION_SECRET, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 },
  };

  app.use('/api', express.json({ limit: '32kb' }));
  app.use('/api/admin', adminRoutes(config, services.admin, session({ ...sessionOptions, name: 'horizon.operator' })));
  app.use('/api/creation', creationRoutes(services.creation));
  app.get('/api/config', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
    (_req, res) => res.json(publicConfig(config, services)));
  app.use('/api', tradingRoutes(config.trading));
  app.get('/health/live', (_req, res) => res.json({ status: 'ok', service: 'horizon-api' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'reachable' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
  });

  const admin = new AdminJS({
    rootPath: '/admin',
    branding: { companyName: 'Horizon', withMadeWithLove: false },
    resources: ['CreationRequest', 'PaymentIntent', 'HumanVerification', 'DiscountUsage', 'MarketResolution', 'AdminAudit', 'JobRun'].map(name => ({
      resource: { model: getModelByName(name), client: db },
      options: {
        navigation: { name: 'Operations' },
        actions: Object.fromEntries(['new', 'edit', 'delete', 'bulkDelete'].map(action => [action, { isAccessible: false, isVisible: false }])),
        // Request bearer tokens are stored hashed; never render the column.
        properties: name === 'CreationRequest' ? { accessTokenHash: { isVisible: false } } : {},
      },
    })),
  });
  await admin.initialize();

  // This phase needs login fields only; do not expose the adapter's upload parser.
  app.use('/admin', (req, res, next) => {
    if (req.is('multipart/form-data')) {
      res.status(415).json({ error: 'uploads_disabled' });
      return;
    }
    next();
  });
  app.post('/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }));
  // AdminJS stays inspection-only. Deliberate actions live behind /api/admin, where they are audited.
  app.use('/admin/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.status(403).json({ error: 'admin_read_only' });
      return;
    }
    next();
  });
  const router = AdminJSExpress.buildAuthenticatedRouter(admin, {
    authenticate: async (email, password) => {
      const valid = await verifyPassword(password, config.ADMIN_PASSWORD_HASH);
      return valid && email === config.ADMIN_EMAIL ? { email } : null;
    },
    cookieName: 'horizon.admin',
    cookiePassword: config.SESSION_SECRET,
  }, undefined, sessionOptions, { maxFieldsSize: 16 * 1024, maxFields: 10 });
  app.use(admin.options.rootPath, router);

  // The built frontend is served by the API when it exists; in development Vite serves it.
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api|admin|health).*/, (_req, res) => res.sendFile(resolve(WEB_DIST, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('HTTP request failed; internal details withheld');
    res.status(500).json({ error: 'internal_error' });
  });
  return { app, admin, services, close: async () => { store.close(); await pool.end(); } };
}
