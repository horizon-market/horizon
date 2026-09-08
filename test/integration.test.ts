import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { enqueueProbe, PROBE_QUEUE, recordProbe, startQueue, type ProbeData } from '../src/jobs.js';
import { loadConfig, type Config } from '../src/config.js';

function testConfig(overrides: Partial<Config> & { DATABASE_URL: string; ADMIN_PASSWORD_HASH: string }): Config {
  return {
    ...loadConfig({
      NODE_ENV: 'test', DATABASE_URL: overrides.DATABASE_URL, ADMIN_EMAIL: 'test@horizon.local',
      ADMIN_PASSWORD_HASH: overrides.ADMIN_PASSWORD_HASH, SESSION_SECRET: randomUUID() + randomUUID(),
    }),
    ...overrides,
  };
}

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}

async function until(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`);
}
function worker(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain pipes without printing possible database errors containing credentials.
  child.stdout?.resume(); child.stderr?.resume();
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 12_000).unref();
  await exited;
  clearTimeout(force);
}

test('Prisma records appear in authenticated AdminJS; anonymous access and writes are blocked', { timeout: 30_000 }, async () => {
  const db = createDatabase(url!);
  const key = randomUUID();
  const record = await db.creationRequest.create({ data: { idempotencyKey: key, question: 'Foundation inspection', requesterKind: 'human' } });
  const password = `test-${randomUUID()}`;
  const built = await createApp(testConfig({ DATABASE_URL: url!, ADMIN_PASSWORD_HASH: await hashPassword(password) }), db);
  const server = built.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    const anonymous = await fetch(`${base}/admin/api/resources/CreationRequest/actions/list`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    const login = await fetch(`${base}/admin/login`, { method: 'POST', body: new URLSearchParams({ email: 'test@horizon.local', password }), redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
    const listed = await fetch(`${base}/admin/api/resources/CreationRequest/actions/list?filters.id=${record.id}`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const data = await listed.json() as { records: { params: { id: string } }[] };
    assert.equal(data.records[0]?.params.id, record.id);
    for (const path of ['actions/new', `records/${record.id}/edit`, `records/${record.id}/delete`]) {
      const denied: Response = await fetch(`${base}/admin/api/resources/CreationRequest/${path}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
      assert.equal(denied.status, 403, path);
    }
    assert.equal(await db.creationRequest.count({ where: { id: record.id } }), 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await built.close();
    await db.creationRequest.delete({ where: { id: record.id } });
    await db.$disconnect();
  }
});

test('a separate worker drains persisted jobs after startup/restart; duplicate deliveries have one database effect', { timeout: 70_000 }, async () => {
  const db = createDatabase(url!);
  const probeId = randomUUID();
  const producer = await startQueue(url!);
  await enqueueProbe(producer, { probeId, label: 'Durability check' });
  await producer.stop();
  let child = worker();
  try {
    await until(async () => !!await db.jobRun.findUnique({ where: { id: probeId } }), 'job persisted while no worker ran');
    await stop(child);
    const nextProducer = await startQueue(url!);
    const duplicate = await enqueueProbe(nextProducer, { probeId, label: 'Duplicate delivery' });
    child = worker();
    try {
      await until(async () => (await nextProducer.getJobById(PROBE_QUEUE, duplicate))?.state === 'completed', 'duplicate after worker restart');
    } finally { await nextProducer.stop(); }
    assert.equal(await db.jobRun.count({ where: { id: probeId } }), 1);
  } finally {
    await stop(child);
    await db.jobRun.deleteMany({ where: { id: probeId } });
    await db.$disconnect();
  }
});

test('pg-boss retries a failed handler and eventually records the job once', { timeout: 40_000 }, async () => {
  const db = createDatabase(url!);
  const boss = await startQueue(url!);
  const probeId = randomUUID();
  let attempts = 0;
  try {
    await boss.work<ProbeData>(PROBE_QUEUE, { pollingIntervalSeconds: 1 }, async jobs => {
      for (const job of jobs) {
        attempts++;
        if (attempts === 1) throw new Error('Intentional transient failure');
        await recordProbe(db, job.id, job.data);
      }
    });
    await enqueueProbe(boss, { probeId, label: 'Retry check' });
    await until(async () => !!await db.jobRun.findUnique({ where: { id: probeId } }), 'retry completion');
    assert.equal(attempts, 2);
    assert.equal(await db.jobRun.count({ where: { id: probeId } }), 1);
  } finally {
    await boss.stop();
    await db.jobRun.deleteMany({ where: { id: probeId } });
    await db.$disconnect();
  }
});
