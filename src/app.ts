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

AdminJS.registerAdapter({ Database, Resource });

export async function createApp(config: Config, db: PrismaClient) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
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
    resources: ['CreationRequest', 'JobRun'].map(name => ({
      resource: { model: getModelByName(name), client: db },
      options: {
        navigation: { name: 'Operations' },
        actions: Object.fromEntries(['new', 'edit', 'delete', 'bulkDelete'].map(action => [action, { isAccessible: false, isVisible: false }])),
      },
    })),
  });
  await admin.initialize();

  const pool = new Pool({ connectionString: config.DATABASE_URL, application_name: 'horizon-admin-sessions' });
  pool.on('error', () => console.error('Admin session database unavailable'));
  const Store = connectPgSimple(session);
  const store = new Store({ pool, tableName: 'AdminSession', createTableIfMissing: false });
  // This phase needs login fields only; do not expose the adapter's upload parser.
  app.use('/admin', (req, res, next) => {
    if (req.is('multipart/form-data')) {
      res.status(415).json({ error: 'uploads_disabled' });
      return;
    }
    next();
  });
  app.post('/admin/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }));
  // Phase 0 admin is inspection-only. Block writes before AdminJS parses bodies;
  // its action-denial responses otherwise use HTTP 200 with an error notice.
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
  }, undefined, {
    store,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 },
  }, { maxFieldsSize: 16 * 1024, maxFields: 10 });
  app.use(admin.options.rootPath, router);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('HTTP request failed; internal details withheld');
    res.status(500).json({ error: 'internal_error' });
  });
  return { app, admin, close: async () => { store.close(); await pool.end(); } };
}
