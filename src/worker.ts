import { loadConfig, databaseUrl } from './config.js';
import { createDatabase } from './db.js';
import { buildServices } from './services.js';
import { startQueue, registerWorker, enqueueAuditPublish, enqueueCreation, enqueueResolution, enqueueMarketSync } from './jobs.js';

const url = databaseUrl();
const config = loadConfig();
const db = createDatabase(url);
await db.$connect();
const boss = await startQueue(url);
const services = buildServices(config, db, {
  enqueueCreation: requestId => enqueueCreation(boss, requestId),
  enqueueResolution: resolutionId => enqueueResolution(boss, resolutionId),
  enqueueAudit: requestId => enqueueAuditPublish(boss, requestId),
});
await registerWorker(boss, db, {
  // A newly created or freshly resolved market must appear without waiting for the next tick.
  createMarket: async requestId => {
    const status = (await services.creation.runCreation(requestId)).status;
    await enqueueMarketSync(boss, 'creation');
    return { status };
  },
  resolveMarket: async resolutionId => {
    const status = (await services.admin.runResolution(resolutionId)).status;
    await enqueueMarketSync(boss, 'resolution');
    return { status };
  },
  publishAudit: async requestId => {
    const report = await services.audit.publishRequest(requestId);
    return { status: report.status, published: report.published };
  },
  syncMarkets: services.syncProjection
    ? async () => { const report = await services.syncProjection!(); return { status: report.status, markets: report.markets }; }
    : undefined,
});

let auditTicker: NodeJS.Timeout | undefined;
if (services.audit.publishing) {
  // The sweep, not the wake-up, is what makes the outbox durable: it recovers a wake-up that was
  // refused while a job was already running, a worker that restarted mid-publication, and any
  // statement still waiting out its retry backoff.
  const sweep = async () => {
    const due = await services.audit.due(20);
    for (const requestId of due) await enqueueAuditPublish(boss, requestId);
  };
  await sweep().catch(() => console.error('Audit outbox sweep failed; retrying on the next tick'));
  auditTicker = setInterval(() => { void sweep().catch(() => console.error('Audit outbox sweep failed; retrying on the next tick')); },
    config.audit.publishIntervalMs);
  auditTicker.unref();
}

let ticker: NodeJS.Timeout | undefined;
if (services.syncProjection) {
  await enqueueMarketSync(boss, 'startup');
  ticker = setInterval(() => { void enqueueMarketSync(boss, 'tick').catch(() => console.error('Market sync could not be enqueued')); },
    config.marketSync.intervalMs);
  ticker.unref();
}
const mirror = services.syncProjection ? `market.sync every ${config.marketSync.intervalMs}ms` : 'market.sync disabled';
const audit = services.audit.publishing
  ? `audit.publish to topic ${config.audit.topicId} on Hedera ${config.audit.network} every ${config.audit.publishIntervalMs}ms`
  : `audit.publish idle (${config.audit.reason})`;
console.log(`Horizon worker ready: system.probe, creation.market (${services.deployer ? 'registry configured' : 'registry not configured'}), market.resolution, ${mirror}, ${audit}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (ticker) clearInterval(ticker);
  if (auditTicker) clearInterval(auditTicker);
  await boss.stop({ graceful: true, timeout: 10_000 });
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
