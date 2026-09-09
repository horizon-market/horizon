import { loadConfig, databaseUrl } from './config.js';
import { createDatabase } from './db.js';
import { buildServices } from './services.js';
import { startQueue, registerWorker, enqueueCreation, enqueueResolution, enqueueMarketSync } from './jobs.js';

const url = databaseUrl();
const config = loadConfig();
const db = createDatabase(url);
await db.$connect();
const boss = await startQueue(url);
const services = buildServices(config, db, {
  enqueueCreation: requestId => enqueueCreation(boss, requestId),
  enqueueResolution: resolutionId => enqueueResolution(boss, resolutionId),
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
  syncMarkets: services.syncProjection
    ? async () => { const report = await services.syncProjection!(); return { status: report.status, markets: report.markets }; }
    : undefined,
});

let ticker: NodeJS.Timeout | undefined;
if (services.syncProjection) {
  await enqueueMarketSync(boss, 'startup');
  ticker = setInterval(() => { void enqueueMarketSync(boss, 'tick').catch(() => console.error('Market sync could not be enqueued')); },
    config.marketSync.intervalMs);
  ticker.unref();
}
const mirror = services.syncProjection ? `market.sync every ${config.marketSync.intervalMs}ms` : 'market.sync disabled';
console.log(`Horizon worker ready: system.probe, creation.market (${services.deployer ? 'registry configured' : 'registry not configured'}), market.resolution, ${mirror}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (ticker) clearInterval(ticker);
  await boss.stop({ graceful: true, timeout: 10_000 });
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
