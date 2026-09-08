import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
await db.$connect();
const { app, close } = await createApp(config, db);
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
    await db.$disconnect();
    clearTimeout(timeout);
  });
  server.closeIdleConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
