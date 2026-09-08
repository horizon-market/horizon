import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL in .env; see .env.example.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Test migrations require a dedicated localhost database named horizon_test.');
}
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'deploy',
], { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
