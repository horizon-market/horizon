import { loadConfig, databaseUrl } from './config.js';
import { createDatabase } from './db.js';
import { buildServices } from './services.js';
import { startQueue, registerWorker, enqueueCreation, enqueueResolution } from './jobs.js';

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
  createMarket: async requestId => ({ status: (await services.creation.runCreation(requestId)).status }),
  resolveMarket: async resolutionId => ({ status: (await services.admin.runResolution(resolutionId)).status }),
});
console.log(`Horizon worker ready: system.probe, creation.market (${services.deployer ? 'registry configured' : 'registry not configured'}), market.resolution`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await boss.stop({ graceful: true, timeout: 10_000 });
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
