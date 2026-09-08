import { randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(deriveKey);

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Use at least 12 characters for the admin password');
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded) || password.length > 1024) return false;
  const [, salt, expected] = encoded.split('$');
  const actual = await scrypt(password, salt!, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected!, 'hex'));
}
