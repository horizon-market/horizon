import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/password.js';
import { PUBLIC_TOPIC, creationTopic, recordLiveEvents } from '../src/live/messages.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);
test.after(async () => { await db.liveEvent.deleteMany(); await db.creationRequest.deleteMany(); await db.$disconnect(); });

type Frame = { id?: string; event: string; data: Record<string, unknown> };
/** Reads frames off an open stream until `count` have arrived or the wait runs out. */
async function collect(response: Response, count: number, ms = 4_000): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  while (frames.length < count && Date.now() < deadline) {
    const next = await Promise.race([reader.read(), delay(deadline - Date.now()).then(() => ({ done: true, value: undefined }))]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame: Frame = { event: 'message', data: {} };
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
      }
      if (block.trim() && !block.startsWith(':')) frames.push(frame);
      boundary = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

test('the live stream fans out public messages, admits private ones by token only, and replays from the last id', { timeout: 30_000 }, async () => {
  await db.liveEvent.deleteMany();
  const config: Config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: url!, ADMIN_EMAIL: 'test@horizon.local', ADMIN_PASSWORD_HASH: await hashPassword(randomUUID()),
    SESSION_SECRET: randomUUID() + randomUUID(), HEDERA_PAYMENT_MODE: 'simulated', HEDERA_RECEIVER_ACCOUNT_ID: '0.0.4242', AI_PROVIDER: 'development',
  });
  const built = await createApp(config, db);
  const server = built.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const token = randomUUID().replace(/-/g, '');
  const mine = await db.creationRequest.create({ data: { idempotencyKey: randomUUID(), question: 'Mine', requesterKind: 'browser', accessTokenHash: createHash('sha256').update(token).digest('hex') } });
  const theirs = await db.creationRequest.create({ data: { idempotencyKey: randomUUID(), question: 'Theirs', requesterKind: 'browser', accessTokenHash: createHash('sha256').update('other').digest('hex') } });
  const open = (headers: Record<string, string> = {}) => fetch(`${base}/api/live`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ creations: [{ id: mine.id, token }, { id: theirs.id, token: 'not-the-right-token' }] }) });
  try {
    const first = await open();
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /text\/event-stream/);
    // Knowing an id is not holding its token: only the request whose token matched is subscribed.
    const [subscribed] = await collect(first, 1);
    assert.deepEqual(subscribed, { event: 'subscribed', data: { topics: [mine.id] } });

    const second = await open();
    await delay(100);
    // Written the way the worker and the consumer write: in a transaction, notified on commit.
    await db.$transaction(tx => recordLiveEvents(tx, [
      { type: 'market.updated', topic: PUBLIC_TOPIC, payload: { market: '0xabc' }, blockNumber: 7 },
      { type: 'creation.updated', topic: creationTopic(mine.id), payload: { requestId: mine.id } },
      { type: 'creation.updated', topic: creationTopic(theirs.id), payload: { requestId: theirs.id } },
    ]));
    const frames = (await collect(second, 3)).slice(1);
    assert.deepEqual(frames.map(frame => [frame.event, frame.data]), [
      ['market.updated', { market: '0xabc' }], ['creation.updated', { requestId: mine.id }],
    ]);
    assert.ok(frames.every(frame => frame.id && /^\d+$/.test(frame.id)));

    // A reconnect with the first id sees what came after it, and nothing it was not subscribed to.
    const resumed = await open({ 'last-event-id': frames[0]!.id! });
    const replayed = await collect(resumed, 2);
    assert.deepEqual(replayed.map(frame => frame.event), ['subscribed', 'creation.updated']);
    assert.equal(replayed[1]!.data.requestId, mine.id);

    // An id older than the retained log is told to refetch rather than served a gap.
    await db.liveEvent.deleteMany({ where: { id: { lte: BigInt(frames[0]!.id!) } } });
    const gap = await open({ 'last-event-id': '1' });
    const told = await collect(gap, 2);
    assert.equal(told[1]!.event, 'snapshot.required');
  } finally {
    // Streams are long-lived by design; they are torn down before the server is asked to close.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await built.close();
  }
});
