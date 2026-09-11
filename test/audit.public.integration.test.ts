import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { loadConfig } from '../src/config.js';
import { auditEventId, draftApproved, encodeAuditMessage, marketCreated, paymentSettled, type AuditRecord } from '../src/audit/events.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);

const TOPIC = '0.0.9000001';
const PAYER = '0.0.4242';
const REQUESTER = '0x243fBaeE0E81EfbC5900F0934f6f4Aa66a249D31';
// Addresses as the deployer returns them: checksummed, which is how a request and a child store
// them. An event member stores the lower-cased form. The public lookup has to find both.
const SINGLE = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa01';
const CHILD_0 = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb02';
const CHILD_1 = '0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc03';
const NOBODY = '0x0000000000000000000000000000000000000000';
const TX = `0x${'ab'.repeat(32)}`;
const PAYMENT_REF = '0.0.4242@1788950000.000000001';
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const draft = { question: 'Will the public audit trail be readable by anyone?', rules: 'Test.', evidenceSource: 'Test.', closeAt: new Date(Date.now() + 86_400_000).toISOString() };

const requests: string[] = [];
const events: string[] = [];
test.after(async () => {
  if (requests.length) await db.creationRequest.deleteMany({ where: { id: { in: requests } } });
  if (events.length) await db.marketEvent.deleteMany({ where: { id: { in: events } } });
  await db.$disconnect();
});

/**
 * The topic as a mirror node would serve it. Seeded from the same canonical encoding the outbox
 * submits, so a verification that matches is a real byte-for-byte comparison; entries can be
 * tampered with or the whole server stopped to exercise the other outcomes.
 */
function mirrorStub() {
  const topic = new Map<string, string>();
  const server = createServer((request, response) => {
    const match = request.url?.match(new RegExp(`^/api/v1/topics/${TOPIC.replace(/\./g, '\\.')}/messages/(\\d+)$`));
    const contents = match && topic.get(match[1]!);
    if (!contents) { response.statusCode = 404; response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      consensus_timestamp: `1788950001.00000000${match[1]}`, sequence_number: Number(match[1]), payer_account_id: PAYER,
      running_hash: Buffer.from('hash').toString('base64'), topic_id: TOPIC, message: Buffer.from(contents).toString('base64'),
    }));
  });
  return { topic, server };
}

/** An outbox row exactly as the workflow writes it, then as the worker leaves it once published. */
function row(record: AuditRecord, published: string | undefined, topic: Map<string, string>): Prisma.AuditEventCreateWithoutRequestInput {
  const contents = encodeAuditMessage(record.message);
  if (published) topic.set(published, contents);
  return {
    eventId: record.eventId, type: record.type, schemaVersion: 'horizon.audit.v1', sequence: record.sequence,
    payload: JSON.parse(contents) as Prisma.InputJsonValue, occurredAt: record.occurredAt, backfilled: false,
    network: 'testnet', topicId: TOPIC,
    ...(published
      ? { status: 'PUBLISHED', sequenceNumber: published, transactionId: `${PAYER}@1788950001.${published.padStart(9, '0')}`, consensusAt: new Date('2026-09-11T10:00:00Z'), attempts: 1 }
      : { status: 'PENDING', nextAttemptAt: new Date() }),
  };
}

test('the public trail is readable by event slug and by market address, and verifiable against the mirror', { timeout: 60_000 }, async () => {
  const mirror = mirrorStub();
  await new Promise<void>(resolve => mirror.server.listen(0, '127.0.0.1', resolve));
  const mirrorUrl = `http://127.0.0.1:${(mirror.server.address() as { port: number }).port}`;
  const tag = randomUUID().slice(0, 8);

  // --- Seed. A single market, and an event built by two requests: the first deployed both
  // children (and still has one statement in flight), the second was only ever approved.
  const single = await db.creationRequest.create({
    data: {
      idempotencyKey: `audit-public-single-${tag}`, question: draft.question, requesterKind: 'browser', requester: REQUESTER,
      accessTokenHash: hash(`token-${tag}`), status: 'CREATED', kind: 'SINGLE', draft, draftHash: hash(`single-${tag}`),
      approvedHash: hash(`single-${tag}`), approvedAt: new Date(), marketAddress: SINGLE, creationTxHash: TX,
    },
  });
  requests.push(single.id);
  const singleCommon = { requestId: single.id, draftHash: hash(`single-${tag}`), occurredAt: new Date('2026-09-11T09:00:00Z') };
  await db.auditEvent.createMany({ data: [
    row(draftApproved(singleCommon), '1', mirror.topic),
    row(paymentSettled({ ...singleCommon, network: 'hedera:testnet', asset: '0.0.0', amountUnits: '100000000', transactionRef: PAYMENT_REF }), '2', mirror.topic),
    row(marketCreated({ ...singleCommon, transactionRef: PAYMENT_REF, chainId: 11155111, address: SINGLE, transactionHash: TX }), '3', mirror.topic),
  ].map(data => ({ ...data, requestId: single.id })) });

  const event = await db.marketEvent.create({
    data: {
      slug: `audit-public-${tag}`, title: 'Public audit event', category: 'Testing', exclusivity: 'EXCLUSIVE', status: 'ACTIVE',
      members: { create: [
        { position: 0, outcomeLabel: 'First', question: 'Will the first child be audited?', marketAddress: CHILD_0.toLowerCase() },
        { position: 1, outcomeLabel: 'Second', question: 'Will the second child be audited?', marketAddress: CHILD_1.toLowerCase() },
      ] },
    },
  });
  events.push(event.id);
  const groupHash = hash(`group-${tag}`);
  const first = await db.creationRequest.create({
    data: {
      idempotencyKey: `audit-public-group-${tag}`, question: 'Public audit event', requesterKind: 'browser', requester: REQUESTER,
      accessTokenHash: hash(`group-token-${tag}`), status: 'CREATED', kind: 'GROUP', eventId: event.id, draftHash: groupHash,
      approvedHash: groupHash, approvedAt: new Date(), createdAt: new Date('2026-09-11T09:00:00Z'),
      children: { create: [
        { position: 0, outcomeLabel: 'First', draft, draftHash: hash('c0'), status: 'CREATED', marketAddress: CHILD_0, creationTxHash: TX },
        { position: 1, outcomeLabel: 'Second', draft, draftHash: hash('c1'), status: 'CREATED', marketAddress: CHILD_1, creationTxHash: TX },
      ] },
    },
  });
  requests.push(first.id);
  const groupCommon = { requestId: first.id, draftHash: groupHash, occurredAt: new Date('2026-09-11T09:05:00Z') };
  await db.auditEvent.createMany({ data: [
    row(draftApproved(groupCommon), '4', mirror.topic),
    row(paymentSettled({ ...groupCommon, network: 'hedera:testnet', asset: '0.0.0', amountUnits: '200000000', transactionRef: PAYMENT_REF }), '5', mirror.topic),
    row(marketCreated({ ...groupCommon, transactionRef: PAYMENT_REF, chainId: 11155111, address: CHILD_0, transactionHash: TX, position: 0 }), '6', mirror.topic),
    row(marketCreated({ ...groupCommon, transactionRef: PAYMENT_REF, chainId: 11155111, address: CHILD_1, transactionHash: TX, position: 1 }), undefined, mirror.topic),
  ].map(data => ({ ...data, requestId: first.id })) });
  const second = await db.creationRequest.create({
    data: {
      idempotencyKey: `audit-public-retry-${tag}`, question: 'Public audit event', requesterKind: 'browser', requester: REQUESTER,
      accessTokenHash: hash(`retry-token-${tag}`), status: 'APPROVED', kind: 'GROUP', eventId: event.id, draftHash: hash(`retry-${tag}`),
      approvedHash: hash(`retry-${tag}`), approvedAt: new Date(), createdAt: new Date('2026-09-11T10:00:00Z'),
    },
  });
  requests.push(second.id);
  await db.auditEvent.create({ data: { ...row(draftApproved({ requestId: second.id, draftHash: hash(`retry-${tag}`), occurredAt: new Date('2026-09-11T10:01:00Z') }), undefined, mirror.topic), requestId: second.id } });

  // --- The API process as production runs it: a topic and a mirror, no signer.
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: url!, ADMIN_EMAIL: 'audit-public-test@horizon.local',
    ADMIN_PASSWORD_HASH: await hashPassword(`test-${randomUUID()}`), SESSION_SECRET: randomUUID() + randomUUID(),
    HEDERA_PAYMENT_MODE: 'simulated', HEDERA_RECEIVER_ACCOUNT_ID: PAYER, AI_PROVIDER: 'development', MARKET_SYNC_ENABLED: 'false',
    HEDERA_AUDIT_TOPIC_ID: TOPIC, HEDERA_MIRROR_NODE_URL: mirrorUrl,
  });
  assert.equal(config.audit.enabled, false);
  const built = await createApp(config, db);
  const server = built.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  type Statement = { type: string; status: string; sequenceNumber: string | null; mirrorUrl: string | null; transactionUrl: string | null; payload: { requestId: string } };
  type Trail = { available: boolean; topicId: string | null; topicUrl: string | null; events: Statement[]; verification?: { eventId: string; checked: boolean; matches: boolean; reason: string | null }[] };

  try {
    // The config no longer warns about a signer this process was never meant to hold.
    const configured = await (await get('/api/config')).json() as { audit: { available: boolean; reason: string | null; topicId: string } };
    assert.equal(configured.audit.available, true);
    assert.equal(configured.audit.reason, null);
    assert.equal(configured.audit.topicId, TOPIC);

    // By slug: every request's statements, oldest request first, each in its own order.
    const bySlug = await get(`/api/audit/events/${event.slug}`);
    assert.equal(bySlug.status, 200);
    const eventTrail = await bySlug.json() as { event: { slug: string; title: string }; requests: { id: string; kind: string; statements: number }[]; audit: Trail };
    assert.equal(eventTrail.event.slug, event.slug);
    assert.deepEqual(eventTrail.requests.map(request => [request.id, request.kind, request.statements]), [[first.id, 'GROUP', 4], [second.id, 'GROUP', 1]]);
    assert.equal(eventTrail.audit.available, true);
    assert.equal(eventTrail.audit.topicUrl, `https://hashscan.io/testnet/topic/${TOPIC}`);
    assert.deepEqual(eventTrail.audit.events.map(statement => [statement.payload.requestId, statement.type, statement.status]), [
      [first.id, 'DRAFT_APPROVED', 'PUBLISHED'], [first.id, 'PAYMENT_SETTLED', 'PUBLISHED'],
      [first.id, 'MARKET_CREATED', 'PUBLISHED'], [first.id, 'MARKET_CREATED', 'PENDING'], [second.id, 'DRAFT_APPROVED', 'PENDING'],
    ]);
    // A readback link exists only where there is something to read back.
    for (const statement of eventTrail.audit.events) {
      if (statement.status === 'PUBLISHED') {
        assert.equal(statement.mirrorUrl, `${mirrorUrl}/api/v1/topics/${TOPIC}/messages/${statement.sequenceNumber}`);
        assert.match(statement.transactionUrl!, /^https:\/\/hashscan\.io\/testnet\/transaction\//);
      } else {
        assert.equal(statement.mirrorUrl, null);
        assert.equal(statement.transactionUrl, null);
      }
    }

    // By address, lower-cased, for a standalone market stored checksummed.
    const bySingle = await get(`/api/audit/markets/${SINGLE.toLowerCase()}`);
    assert.equal(bySingle.status, 200);
    const singleTrail = await bySingle.json() as { market: { address: string; position: number | null; outcomeLabel: string | null; eventId: string }; request: { id: string; kind: string }; event: null; audit: Trail };
    assert.equal(singleTrail.market.address, SINGLE.toLowerCase());
    assert.equal(singleTrail.market.position, null);
    assert.equal(singleTrail.market.outcomeLabel, null);
    assert.equal(singleTrail.market.eventId, auditEventId(single.id, 'MARKET_CREATED'));
    assert.equal(singleTrail.request.id, single.id);
    assert.equal(singleTrail.event, null);
    assert.equal(singleTrail.audit.events.length, 3);
    assert.ok(singleTrail.audit.events.some(statement => statement.type === 'MARKET_CREATED' && statement.status === 'PUBLISHED'));

    // By address, upper-cased, for a child of a group: the whole request, with this child named.
    const byChild = await get(`/api/audit/markets/${CHILD_1.toUpperCase().replace('0X', '0x')}`);
    assert.equal(byChild.status, 200);
    // `event` is null on a standalone trail and an object here; an intersection of the two is `never`.
    const childTrail = await byChild.json() as Omit<typeof singleTrail, 'event'> & { event: { slug: string; title: string } };
    assert.equal(childTrail.market.address, CHILD_1.toLowerCase());
    assert.equal(childTrail.market.position, 1);
    assert.equal(childTrail.market.outcomeLabel, 'Second');
    assert.equal(childTrail.market.eventId, auditEventId(first.id, 'MARKET_CREATED', 1));
    assert.equal(childTrail.request.id, first.id);
    assert.equal(childTrail.event.slug, event.slug);
    assert.equal(childTrail.audit.events.length, 4);

    // Unknown and malformed identifiers.
    for (const [path, status, error] of [
      ['/api/audit/events/no-such-event', 404, 'unknown_event'], ['/api/audit/events/Not-A-Slug', 400, 'invalid_event'],
      [`/api/audit/markets/${NOBODY}`, 404, 'unknown_market'], ['/api/audit/markets/nope', 400, 'invalid_market'],
    ] as const) {
      const response = await get(path);
      assert.equal(response.status, status, path);
      assert.equal(((await response.json()) as { error: string }).error, error);
    }

    // Verification reads each published statement back and compares it byte for byte.
    const verified = (await (await get(`/api/audit/events/${event.slug}?verify=1`)).json() as { audit: Trail }).audit;
    assert.equal(verified.verification!.length, 5);
    assert.deepEqual(verified.verification!.map(entry => [entry.checked, entry.matches, entry.reason]), [
      [true, true, null], [true, true, null], [true, true, null], [false, false, 'not_published'], [false, false, 'not_published'],
    ]);
    // A tampered topic entry is reported as different, never silently accepted.
    mirror.topic.set('5', mirror.topic.get('5')!.replace('200000000', '200000001'));
    const tampered = (await (await get(`/api/audit/events/${event.slug}?verify=1`)).json() as { audit: Trail }).audit;
    assert.deepEqual(tampered.verification!.slice(0, 3).map(entry => entry.reason), [null, 'contents_differ', null]);
    // An unreachable mirror is a failure to check, not a failure to match.
    await new Promise<void>(resolve => mirror.server.close(() => resolve()));
    const unreachable = (await (await get(`/api/audit/markets/${SINGLE}?verify=1`)).json() as { audit: Trail }).audit;
    assert.deepEqual(unreachable.verification!.map(entry => [entry.checked, entry.reason]), [[false, 'mirror_unavailable'], [false, 'mirror_unavailable'], [false, 'mirror_unavailable']]);

    // Nothing private rides along: no token hash, no requester, no payer, no draft.
    for (const body of [JSON.stringify(eventTrail), JSON.stringify(singleTrail), JSON.stringify(childTrail)]) {
      for (const secret of [hash(`token-${tag}`), hash(`group-token-${tag}`), REQUESTER, draft.question]) assert.ok(!body.includes(secret));
      for (const key of ['accessTokenHash', 'requester', 'payTo', 'payer', 'status":"CREATED', 'status":"APPROVED']) assert.ok(!body.includes(key), key);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await built.close();
  }
});
