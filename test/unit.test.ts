import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from '../src/password.js';
import { loadConfig } from '../src/config.js';

test('admin password hashes are salted and reject wrong or malformed credentials', async () => {
  const password = 'foundation-test-password';
  const hash = await hashPassword(password);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
});

test('configuration validation identifies fields without leaking secrets', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'private-value-do-not-log', SESSION_SECRET: 'secret-value' }), error => {
    assert(error instanceof Error);
    assert.match(error.message, /DATABASE_URL/);
    assert(!error.message.includes('private-value-do-not-log'));
    assert(!error.message.includes('secret-value'));
    return true;
  });
});

test('World sandbox is preserved as an IDKit environment', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://horizon:test@127.0.0.1:5432/horizon',
    ADMIN_EMAIL: 'admin@horizon.local',
    ADMIN_PASSWORD_HASH: `scrypt$${'11'.repeat(16)}$${'22'.repeat(64)}`,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    WORLD_ENVIRONMENT: 'sandbox',
  });
  assert.equal(config.world.environment, 'sandbox');
});
