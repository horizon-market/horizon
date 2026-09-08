import { databaseUrl } from './config.js';
import { createDatabase } from './db.js';
import { startQueue, registerWorker } from './jobs.js';

const url = databaseUrl();
const db = createDatabase(url);
await db.$connect();
const boss = await startQueue(url);
await registerWorker(boss, db);
console.log('Horizon worker ready: system.probe (diagnostic only)');
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await boss.stop({ graceful: true, timeout: 10_000 });
  await db.$disconnect();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
