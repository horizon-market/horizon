import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/password.js';

if (existsSync('.env')) throw new Error('.env already exists; refusing to overwrite your configuration.');
const password = randomBytes(24).toString('base64url');
const hash = await hashPassword(password);
const template = await readFile('.env.example', 'utf8');
await mkdir('.local', { recursive: true, mode: 0o700 });
await writeFile('.local/admin-password.txt', password + '\n', { mode: 0o600, flag: 'wx' });
await writeFile('.env', template.replace(/^ADMIN_PASSWORD_HASH=$/m, `ADMIN_PASSWORD_HASH=${hash}`).replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString('hex')}`), { mode: 0o600, flag: 'wx' });
console.log('Created .env and .local/admin-password.txt (private local files). Admin email: admin@horizon.local. No sponsor credentials were generated.');
