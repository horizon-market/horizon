import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { startQueue, enqueueAuditPublish, enqueueCreation, enqueueResolution } from './jobs.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
await db.$connect();
// The API only enqueues durable work; the separate worker process runs it.
const boss = await startQueue(config.DATABASE_URL);
const { app, close } = await createApp(config, db, {
  enqueueCreation: requestId => enqueueCreation(boss, requestId),
  enqueueResolution: resolutionId => enqueueResolution(boss, resolutionId),
  // An approval commits in the API process, so it wakes the publisher from here. A wake-up that
  // never lands is not lost: the worker's sweep picks the statement up on its next tick.
  enqueueAudit: requestId => enqueueAuditPublish(boss, requestId),
});
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`Horizon API: http://${config.HOST}:${config.PORT}; admin: /admin`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 15_000).unref();
  server.close(async () => {
    await close();
    await boss.stop({ graceful: true, timeout: 5_000 });
    await db.$disconnect();
    clearTimeout(timeout);
  });
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
