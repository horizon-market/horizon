import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Prisma } from '@prisma/client';
import { createDatabase } from '../src/db.js';
import { CreationService } from '../src/creation/service.js';
import { draftHash, draftSchema } from '../src/creation/types.js';
import { DevelopmentDraftProvider } from '../src/creation/ai.js';
import type { PaymentFacilitator, PaymentPayload, PaymentRequirements } from '../src/payments/x402.js';
import type { HumanVerifier } from '../src/world/verifier.js';
import type { MarketDeployer } from '../src/creation/onchain.js';
import type { AuditConfig, PaymentsConfig, WorldConfig } from '../src/config.js';
import { AuditService } from '../src/audit/service.js';
import {
  AuditPublishAmbiguousError, AuditPublishRejectedError, AuditPublishUnavailableError,
  MirrorNodeReader, UnconfiguredAuditPublisher, type AuditPublisher, type MirrorMessage, type PublishResult,
} from '../src/audit/hcs.js';
import { auditEventId, encodeAuditMessage, type AuditRecord } from '../src/audit/events.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);

const TOPIC = '0.0.9000001';
const MARKET = '0x5555555555555555555555555555555555555555' as const;
const CREATION_TX = `0x${'ab'.repeat(32)}` as const;
const REQUESTER = '0x243fBaeE0E81EfbC5900F0934f6f4Aa66a249D31';
const NULLIFIER_PREFIX = 'audit-test-nullifier';

const payments: PaymentsConfig = {
  facilitatorUrl: 'https://facilitator.invalid', network: 'hedera:testnet', payTo: '0.0.4242',
  asset: '0.0.0', assetDecimals: 8, mode: 'simulated', priceUnits: 100_000_000n, discountBps: 5000, timeoutSeconds: 300,
};
const world: WorldConfig = { appId: 'app_test', rpId: 'rp_test', action: 'create-market', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.world.org' };
const auditConfig: AuditConfig = {
  enabled: true, reason: 'Configured.', network: 'testnet', topicId: TOPIC,
  operatorId: '0.0.4242', operatorKey: `0x${'7f'.repeat(32)}`, keyType: 'ecdsa',
  mirrorNodeUrl: 'https://testnet.mirrornode.hedera.invalid', explorerBase: 'https://hashscan.io/testnet',
  publishIntervalMs: 20_000, maxAttempts: 3, retryBaseMs: 5_000, retryMaxMs: 300_000, requestTimeoutMs: 30_000,
};

/** A scripted topic. Each entry decides what the next submission does. */
type Outcome = 'ok' | 'unavailable' | 'ambiguous' | 'ambiguous-with-id' | 'rejected';
class ScriptedPublisher implements AuditPublisher {
  readonly available = true;
  readonly network = 'testnet';
  readonly topicId = TOPIC;
  readonly submitted: string[] = [];
  /** Messages that actually reached consensus, in order — the topic as a reader would see it. */
  readonly topic: string[] = [];
  private sequence = 0;
  constructor(private script: Outcome[] = []) {}
  plan(...outcomes: Outcome[]) { this.script.push(...outcomes); return this; }
  async publish(message: string): Promise<PublishResult> {
    this.submitted.push(message);
    const outcome = this.script.shift() ?? 'ok';
    if (outcome === 'unavailable') throw new AuditPublishUnavailableError('BUSY');
    if (outcome === 'rejected') throw new AuditPublishRejectedError('INVALID_TOPIC_ID');
    if (outcome === 'ambiguous') throw new AuditPublishAmbiguousError('timeout');
    this.sequence += 1;
    // An ambiguous outcome that reached consensus anyway: the topic has it, this process does not
    // know that, and only a mirror-node readback can tell the difference.
    this.topic.push(message);
    if (outcome === 'ambiguous-with-id') throw new AuditPublishAmbiguousError('timeout', `0.0.4242@178895000${this.sequence}.000000001`);
    return {
      transactionId: `0.0.4242@178895000${this.sequence}.000000001`,
      consensusAt: new Date(1_788_950_000_000 + this.sequence * 1000),
      sequenceNumber: String(this.sequence),
    };
  }
  close() { /* nothing to close */ }
}

/** A mirror node backed by the scripted topic, so reconciliation is exercised for real. */
class ScriptedMirror extends MirrorNodeReader {
  reachable = true;
  constructor(private publisher: ScriptedPublisher) { super(auditConfig.mirrorNodeUrl); }
  private find(contents: string): MirrorMessage {
    const index = this.publisher.topic.indexOf(contents);
    return {
      consensusTimestamp: `178895000${index + 1}.000000001`, sequenceNumber: String(index + 1),
      payerAccountId: '0.0.4242', runningHash: 'aGFzaA==', contents,
    };
  }
  override async findByEventId(_topicId: string, eventId: string) {
    if (!this.reachable) throw new Error('mirror_unavailable');
    const contents = this.publisher.topic.find(message => message.includes(eventId));
    return contents ? this.find(contents) : undefined;
  }
  override async message(_topicId: string, sequenceNumber: string) {
    if (!this.reachable) throw new Error('mirror_unavailable');
    const contents = this.publisher.topic[Number(sequenceNumber) - 1];
    return contents ? this.find(contents) : undefined;
  }
}

class StubFacilitator implements PaymentFacilitator {
  readonly name = 'audit-test-facilitator';
  readonly mode = 'simulated' as const;
  settleCalls = 0;
  async prepare(requirements: PaymentRequirements) { return { ...requirements, extra: { ...requirements.extra, feePayer: '0.0.7000' } }; }
  async verify() { return { valid: true, payer: '0.0.99' }; }
  async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
    this.settleCalls++;
    return { transaction: `0.0.99@1788954987.${this.settleCalls}${requirements.extra.nonce.slice(0, 6)}`, payer: '0.0.99', network: requirements.network, mode: this.mode };
  }
}
class StubDeployer implements MarketDeployer {
  readonly resolver = '0x6666666666666666666666666666666666666666' as const;
  calls = 0;
  private existing?: typeof MARKET;
  async find() { return this.existing; }
  async create() {
    this.calls++;
    if (this.existing) return { market: this.existing, alreadyExisted: true };
    this.existing = MARKET;
    return { market: MARKET, transactionHash: CREATION_TX, alreadyExisted: false };
  }
}

const created: string[] = [];
const context = async () => ({ available: true, context: { indexedBlock: 100, markets: [] } });

function build(overrides: { publisher?: AuditPublisher; mirror?: MirrorNodeReader; audit?: AuditService; deployer?: MarketDeployer; facilitator?: PaymentFacilitator } = {}) {
  const publisher = overrides.publisher ?? new ScriptedPublisher();
  const mirror = overrides.mirror ?? (publisher instanceof ScriptedPublisher ? new ScriptedMirror(publisher) : new MirrorNodeReader(auditConfig.mirrorNodeUrl));
  const audit = overrides.audit ?? new AuditService({ db, config: auditConfig, publisher, mirror });
  const facilitator = overrides.facilitator ?? new StubFacilitator();
  const deployer = overrides.deployer ?? new StubDeployer();
  const service = new CreationService({
    db, provider: new DevelopmentDraftProvider(), payments, world, context, facilitator, deployer, audit, chainId: 11155111,
    verifier: { name: 'unavailable', available: false, reason: 'no access', verify: async () => { throw new Error('unavailable'); } } as HumanVerifier,
  });
  return { service, audit, publisher, mirror, facilitator, deployer };
}

const payload = (requirements: PaymentRequirements) => Buffer.from(JSON.stringify({
  x402Version: 2, accepted: requirements, payload: { payer: '0.0.99', nonce: randomUUID() },
})).toString('base64');

async function newRequest(service: CreationService, question = 'Will the Horizon audit trail record exactly one statement per workflow step?') {
  const result = await service.createDraft({ idempotencyKey: randomUUID(), question, requesterKind: 'browser', requester: REQUESTER });
  created.push(result.request.id);
  return { id: result.request.id, token: result.token!, request: result.request };
}

/** Draft, approve, pay and create one request end to end. */
async function completeRequest(built: ReturnType<typeof build>, question?: string) {
  const { service } = built;
  const { id, token, request } = await newRequest(service, question);
  await service.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  const issued = await service.requirePayment(id, token, 'https://horizon.local/api/creation/requests/x/payment');
  const requirements = await service.requirements(issued.payment);
  await service.submitPayment(id, token, payload(requirements), 'https://horizon.local/api/creation/requests/x/payment');
  await service.runCreation(id);
  return { id, token };
}

const rows = (requestId: string) => db.auditEvent.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } });

/**
 * A clock the test moves forward, so retry backoff is exercised rather than waited out. `start`
 * resets it to the present, which matters because the outbox rows are written by the workflow
 * against the real clock before the publisher is ever asked to run.
 */
function clock() {
  let at = Date.now();
  return { now: () => new Date(at), start: () => { at = Date.now(); }, advance: (ms = 3_600_000) => { at += ms; } };
}

test.after(async () => {
  if (created.length) await db.creationRequest.deleteMany({ where: { id: { in: created } } });
  await db.discountUsage.deleteMany({ where: { nullifierHash: { startsWith: NULLIFIER_PREFIX } } });
  await db.$disconnect();
});

test('each workflow transition writes exactly one statement, in order, in its own transaction', { timeout: 30_000 }, async () => {
  const built = build();
  const { id } = await completeRequest(built);

  const events = await rows(id);
  assert.deepEqual(events.map(event => event.type), ['DRAFT_APPROVED', 'PAYMENT_SETTLED', 'MARKET_CREATED']);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.ok(events.every(event => event.schemaVersion === 'horizon.audit.v1'));
  assert.ok(events.every(event => event.status === 'PENDING' && event.attempts === 0 && !event.consensusAt));
  assert.ok(events.every(event => !event.backfilled), 'a statement written by the workflow is not a backfill');

  const request = await db.creationRequest.findUniqueOrThrow({ where: { id }, include: { payment: true } });
  const [approved, settled, market] = events.map(event => event.payload as Record<string, unknown>);
  assert.equal(approved!.draftHash, request.approvedHash, 'the existing canonical draft hash is reused, not recomputed');
  assert.deepEqual(settled!.payment, {
    network: 'hedera:testnet', asset: '0.0.0', amountUnits: '100000000', transactionRef: request.payment!.transactionRef,
  });
  assert.deepEqual(market!.market, { chainId: 11155111, address: MARKET, transactionHash: CREATION_TX });
  assert.equal((market!.payment as Record<string, string>).transactionRef, request.payment!.transactionRef);
  // Every statement is addressable by an id derived from the request and its type.
  assert.deepEqual(events.map(event => event.eventId), [
    auditEventId(id, 'DRAFT_APPROVED'), auditEventId(id, 'PAYMENT_SETTLED'), auditEventId(id, 'MARKET_CREATED'),
  ]);
});

test('a statement that cannot be written rolls its transition back with it', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher();
  // An outbox write that fails must take the workflow transition down with it; anything else
  // would leave an approved request whose statement nothing had recorded.
  class BrokenAudit extends AuditService {
    override async record(tx: Prisma.TransactionClient, record: AuditRecord) {
      await super.record(tx, record);
      throw new Error('outbox_write_failed');
    }
  }
  const audit = new BrokenAudit({ db, config: auditConfig, publisher, mirror: new ScriptedMirror(publisher) });
  const { service } = build({ audit, publisher });
  const { id, token, request } = await newRequest(service, 'Will an outbox failure roll back the approval it belongs to?');
  await assert.rejects(() => service.approve(id, token, draftHash(draftSchema.parse(request.draft))), /outbox_write_failed/);
  assert.equal((await db.creationRequest.findUniqueOrThrow({ where: { id } })).status, 'DRAFT');
  assert.equal((await rows(id)).length, 0, 'the outbox row must not survive the rolled-back transition');
});

test('an unreachable topic never repeats a payment or a deployment', { timeout: 30_000 }, async () => {
  // Every submission fails, in every way the network can fail.
  const publisher = new ScriptedPublisher(['unavailable', 'ambiguous', 'rejected', 'unavailable', 'ambiguous', 'unavailable']);
  const built = build({ publisher });
  const { id } = await completeRequest(built, 'Will a Hedera outage leave the Horizon creation workflow completely unchanged?');

  for (let attempt = 0; attempt < 4; attempt++) await built.audit.publishRequest(id);
  const request = await db.creationRequest.findUniqueOrThrow({ where: { id }, include: { payment: true } });
  // The workflow completed and stayed completed, exactly once each.
  assert.equal(request.status, 'CREATED');
  assert.equal(request.marketAddress, MARKET);
  assert.equal(request.payment!.status, 'SETTLED');
  assert.equal(request.payment!.attempts, 1);
  assert.equal((built.facilitator as StubFacilitator).settleCalls, 1, 'a failed publication must not settle again');
  assert.equal((built.deployer as StubDeployer).calls, 1, 'a failed publication must not deploy again');
  // Nothing is reported as published, and no statement borrows a consensus timestamp.
  const events = await rows(id);
  assert.ok(events.every(event => event.status !== 'PUBLISHED'));
  assert.ok(events.every(event => event.consensusAt === null && event.sequenceNumber === null));
});

test('publication is ordered, retried, and stops at the first statement it cannot confirm', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher(['ok', 'unavailable']);
  const built = build({ publisher });
  const time = clock();
  const audit = new AuditService({ db, config: auditConfig, publisher, mirror: new ScriptedMirror(publisher), now: time.now });
  const { id } = await completeRequest(built, 'Will the audit publisher stop at the first statement it cannot confirm?');
  time.start();
  const first = await audit.publishRequest(id);
  assert.equal(first.published, 1);
  assert.equal(first.status, 'blocked');
  let events = await rows(id);
  assert.equal(events[0]!.status, 'PUBLISHED');
  assert.equal(events[1]!.status, 'PENDING');
  // The market statement is never submitted ahead of the payment statement it depends on.
  assert.equal(events[2]!.status, 'PENDING');
  assert.equal(events[2]!.attempts, 0);
  assert.equal(publisher.submitted.length, 2);
  assert.ok(events[1]!.nextAttemptAt! > time.now(), 'a failed statement waits out its backoff');

  // The retry resumes at the payment statement and finishes the trail in order.
  time.advance();
  const second = await audit.publishRequest(id);
  assert.equal(second.published, 2);
  assert.equal(second.status, 'published');
  events = await rows(id);
  assert.deepEqual(events.map(event => event.status), ['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
  assert.deepEqual(events.map(event => event.sequenceNumber), ['1', '2', '3']);
  assert.deepEqual(publisher.topic.map(message => (JSON.parse(message) as { type: string }).type),
    ['DRAFT_APPROVED', 'PAYMENT_SETTLED', 'MARKET_CREATED']);
  assert.ok(events.every(event => event.consensusAt !== null && event.transactionId !== null));
  assert.equal(events[1]!.attempts, 2, 'the failed attempt is counted, not hidden');
});

test('an unknown outcome is reconciled against the mirror node instead of resubmitted', { timeout: 30_000 }, async () => {
  // The submission reached consensus and the result never came back to this process.
  const publisher = new ScriptedPublisher(['ambiguous-with-id']);
  const built = build({ publisher });
  const mirror = new ScriptedMirror(publisher);
  const time = clock();
  const audit = new AuditService({ db, config: auditConfig, publisher, mirror, now: time.now });
  const { id } = await completeRequest(built, 'Will an unknown Hedera submission outcome be reconciled rather than sent twice?');
  time.start();
  await audit.publishRequest(id);
  let approved = (await rows(id))[0]!;
  assert.equal(approved.status, 'UNCONFIRMED', 'an unknown outcome is never reported as published');
  assert.equal(approved.consensusAt, null);
  assert.ok(approved.transactionId, 'the transaction reference is kept for reconciliation');

  time.advance();
  await audit.publishRequest(id);
  approved = (await rows(id))[0]!;
  assert.equal(approved.status, 'PUBLISHED');
  assert.equal(approved.sequenceNumber, '1');
  assert.ok(approved.consensusAt);
  // Reconciled, not resubmitted: the topic still holds exactly one copy of that statement.
  assert.equal(publisher.topic.filter(message => message.includes(approved.eventId)).length, 1);
  assert.equal(publisher.submitted.filter(message => message.includes(approved.eventId)).length, 1);
});

test('a redelivered workflow step writes no second statement, and republishing changes nothing', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher();
  const built = build({ publisher });
  const { id, token } = await completeRequest(built, 'Will a redelivered creation job produce a second audit statement?');
  const before = await rows(id);
  const replayed = await db.creationRequest.findUniqueOrThrow({ where: { id } });
  // An approval replayed while the request was still APPROVED is a no-op on the trail too; here
  // the request has moved on, and the workflow refuses the transition outright.
  await assert.rejects(() => built.service.approve(id, token, replayed.approvedHash!), /invalid_transition/);

  // The creation job, redelivered twice exactly as pg-boss can redeliver it, and an approval
  // replayed on a request that is already approved.
  const request = await db.creationRequest.findUniqueOrThrow({ where: { id } });
  assert.equal(request.status, 'CREATED');
  await built.service.runCreation(id);
  await built.service.runCreation(id);
  const after = await rows(id);
  assert.equal(after.length, before.length, 'a redelivered step must not add a statement');
  assert.deepEqual(after.map(event => event.eventId), before.map(event => event.eventId));
  assert.equal((built.deployer as StubDeployer).calls, 1);

  await built.audit.publishRequest(id);
  assert.equal(publisher.topic.length, 3);
  // A second publication pass has nothing left to send.
  const report = await built.audit.publishRequest(id);
  assert.equal(report.published, 0);
  assert.equal(report.pending, 0);
  assert.equal(publisher.submitted.length, 3);
});

test('a permanently refused statement fails, and a retry budget is not spent forever', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher(['rejected']);
  const built = build({ publisher });
  const time = clock();
  const audit = new AuditService({ db, config: auditConfig, publisher, mirror: new ScriptedMirror(publisher), now: time.now });
  const { id } = await completeRequest(built, 'Will a permanently refused audit statement be marked failed rather than retried?');
  time.start();
  await audit.publishRequest(id);
  const failed = (await rows(id))[0]!;
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureCode, 'INVALID_TOPIC_ID');
  assert.equal(failed.nextAttemptAt, null, 'a refused statement is not queued for another attempt');

  // A statement whose outcome stays unknown is parked, never silently declared published.
  const unknown = new ScriptedPublisher(['ambiguous', 'ambiguous', 'ambiguous', 'ambiguous']);
  const other = build({ publisher: unknown });
  const mirror = new ScriptedMirror(unknown);
  mirror.reachable = false;
  const parkedTime = clock();
  const parked = new AuditService({ db, config: { ...auditConfig, maxAttempts: 2 }, publisher: unknown, mirror, now: parkedTime.now });
  const { id: parkedId } = await completeRequest(other, 'Will an audit statement whose outcome is never known be parked for an operator?');
  parkedTime.start();
  for (let attempt = 0; attempt < 3; attempt++) { await parked.publishRequest(parkedId); parkedTime.advance(); }
  const row = (await rows(parkedId))[0]!;
  assert.equal(row.status, 'UNCONFIRMED');
  assert.equal(row.failureCode, 'audit_publication_unconfirmed');
  assert.equal(row.nextAttemptAt, null);
  assert.equal(row.consensusAt, null);
});

test('the stored trail carries no secret, no token, no proof and no requester', { timeout: 30_000 }, async () => {
  const built = build();
  const { id, token } = await completeRequest(built, 'Will a published Horizon statement ever contain a secret or a person?');
  const request = await db.creationRequest.findUniqueOrThrow({ where: { id }, include: { payment: true } });
  const events = await rows(id);
  const published = events.map(event => encodeAuditMessage(event.payload)).join('\n');
  for (const secret of [token, request.accessTokenHash, REQUESTER, request.question, auditConfig.operatorKey!]) {
    assert.ok(secret && !published.includes(secret), `a statement must not contain ${secret?.slice(0, 12)}…`);
  }
  // The settled transaction reference is an intended public field — it is already on the Hedera
  // ledger and already in the request view — but the payer is not a field of any statement.
  for (const event of events) assert.ok(!('payer' in (event.payload as Record<string, unknown>)));
  // The public view is the same closed set of fields, and it exposes no stored token either.
  const view = built.audit.present(events);
  assert.equal(view.topicId, TOPIC);
  assert.equal(view.delivery, 'at_least_once');
  assert.match(view.note, /does not independently verify/);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(token) && !serialized.includes(request.accessTokenHash) && !serialized.includes(auditConfig.operatorKey!));
});

test('a published statement is read back from the mirror node and compared byte for byte', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher();
  const built = build({ publisher });
  const mirror = new ScriptedMirror(publisher);
  const audit = new AuditService({ db, config: auditConfig, publisher, mirror });
  const { id } = await completeRequest(built, 'Will the Horizon audit trail read back byte for byte from the Hedera mirror node?');
  await audit.publishRequest(id);
  const events = await rows(id);

  const verified = await audit.verify(events);
  assert.equal(verified.length, 3);
  assert.ok(verified.every(result => result.checked && result.matches && result.schemaValid));
  assert.deepEqual(verified.map(result => result.sequenceNumber), ['1', '2', '3']);

  // A topic that disagrees with the stored statement is reported, not glossed over.
  publisher.topic[0] = publisher.topic[0]!.replace(/"draftHash":"[a-f0-9]{64}"/, `"draftHash":"${'b'.repeat(64)}"`);
  const tampered = await audit.verify(events);
  assert.equal(tampered[0]!.matches, false);
  assert.equal(tampered[0]!.reason, 'contents_differ');
  assert.equal(tampered[1]!.matches, true);

  // And an unreachable mirror is an unknown, never a pass.
  mirror.reachable = false;
  assert.deepEqual((await audit.verify(events)).map(result => result.reason), ['mirror_unavailable', 'mirror_unavailable', 'mirror_unavailable']);
});

test('a backfilled statement never claims its event time as a consensus timestamp', { timeout: 30_000 }, async () => {
  const publisher = new ScriptedPublisher();
  const built = build({ publisher });
  const { id } = await completeRequest(built, 'Will a backfilled Horizon statement be presented as having happened at consensus?');
  // Simulate a request that completed before the trail existed: drop its rows, then backfill.
  const original = await rows(id);
  await db.auditEvent.deleteMany({ where: { requestId: id } });
  const request = await db.creationRequest.findUniqueOrThrow({ where: { id }, include: { payment: true } });
  const { draftApproved } = await import('../src/audit/events.js');
  await db.$transaction(async tx => built.audit.record(tx, draftApproved({
    requestId: id, draftHash: request.approvedHash!, occurredAt: request.approvedAt!, backfilled: true,
  })));

  const [row] = await rows(id);
  assert.equal(row!.backfilled, true);
  assert.equal(row!.eventId, original[0]!.eventId, 'a backfill records the same statement, not a new one');
  assert.equal((row!.payload as Record<string, unknown>).backfilled, true);
  assert.equal((row!.payload as Record<string, string>).occurredAt, request.approvedAt!.toISOString());

  await built.audit.publishRequest(id);
  const [published] = await rows(id);
  assert.equal(published!.status, 'PUBLISHED');
  // The consensus timestamp is the publication time and is far from the event time; the view
  // says so on the row itself rather than leaving a reader to assume they are the same.
  assert.notEqual(published!.consensusAt!.toISOString(), published!.occurredAt.toISOString());
  const view = built.audit.present(await rows(id));
  assert.equal(view.events[0]!.backfilled, true);
  assert.match(view.events[0]!.timestampNote!, /not when the event happened/);
});

test('with no topic configured the trail is still recorded, and nothing is reported as published', { timeout: 30_000 }, async () => {
  const config: AuditConfig = { ...auditConfig, enabled: false, topicId: '', reason: 'Publication is not configured: set HEDERA_AUDIT_TOPIC_ID.' };
  const publisher = new UnconfiguredAuditPublisher();
  const audit = new AuditService({ db, config, publisher, mirror: new MirrorNodeReader(config.mirrorNodeUrl) });
  const built = build({ publisher, audit });
  const { id } = await completeRequest(built, 'Will Horizon still record its statements when no Hedera topic is configured?');

  const events = await rows(id);
  assert.equal(events.length, 3, 'the outbox records the trail whether or not it can be published');
  assert.ok(events.every(event => event.status === 'PENDING' && event.topicId === null));
  const report = await audit.publishRequest(id);
  assert.equal(report.status, 'not_configured');
  const view = audit.present(events);
  assert.equal(view.available, false);
  assert.equal(view.topicId, null);
  assert.ok(view.events.every(event => event.consensusAt === null && event.transactionId === null));
});
