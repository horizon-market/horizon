import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import type { Address } from 'viem';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { loadConfig } from '../src/config.js';
import { CreationService, WorkflowError } from '../src/creation/service.js';
import { DevelopmentDraftProvider } from '../src/creation/ai.js';
import { EventService } from '../src/events/service.js';
import { AdminService } from '../src/admin/service.js';
import { GammaClient, POLYMARKET_API_ORIGIN } from '../src/imports/polymarket.js';
import { creationId, type MarketDeployer, type MarketPlan } from '../src/creation/onchain.js';
import { creationTopic } from '../src/live/messages.js';
import type { PaymentFacilitator, PaymentPayload, PaymentRequirements } from '../src/payments/x402.js';
import type { HumanVerifier } from '../src/world/verifier.js';
import type { ImportsConfig, PaymentsConfig, WorldConfig } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to the migrated local horizon_test database.');
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/horizon_test') {
  throw new Error('Integration tests require a dedicated localhost database named horizon_test.');
}
const db = createDatabase(url);

const payments: PaymentsConfig = { facilitatorUrl: 'https://facilitator.invalid', network: 'hedera:testnet', payTo: '0.0.4242',
  asset: '0.0.0', assetDecimals: 8, mode: 'simulated', priceUnits: 100_000_000n, discountBps: 5000, timeoutSeconds: 300 };
const world: WorldConfig = { appId: 'app_test', rpId: 'rp_test', action: 'create-market', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.world.org' };
const imports: ImportsConfig = { enabled: true, polymarketApiOrigin: POLYMARKET_API_ORIGIN, timeoutMs: 5_000, maxChildren: 24 };
const REQUESTER = '0x243fBaeE0E81EfbC5900F0934f6f4Aa66a249D31';

/**
 * The fixture's own close time is fixed and long past by the time this suite runs, so the source
 * dates are shifted forward on the way in. Everything else — outcomes, labels, rules, negative-risk
 * grouping — is the real Gamma payload.
 */
const raw = JSON.parse(readFileSync(new URL('./fixtures/polymarket-event-match.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const CLOSE_AT = new Date(Date.now() + 20 * 24 * 3600 * 1000);
/**
 * Importing one source event twice is refused on purpose, so each test works on its own copy of
 * the fixture under a distinct source id and slug. The content is otherwise the real payload.
 */
const sourceEvent = (tag: string) => {
  const shifted = structuredClone(raw);
  shifted.id = `931729-${tag}`;
  shifted.slug = `ucl-bay-bog-${tag}`;
  shifted.ticker = shifted.slug;
  shifted.endDate = CLOSE_AT.toISOString();
  shifted.startTime = CLOSE_AT.toISOString();
  for (const [index, market] of (shifted.markets as Record<string, unknown>[]).entries()) {
    market.id = `3977564-${tag}-${index}`;
    market.slug = `ucl-bay-bog-${tag}-${['bay', 'draw', 'bog'][index]}`;
    market.endDate = CLOSE_AT.toISOString();
    market.endDateIso = CLOSE_AT.toISOString().slice(0, 10);
    market.gameStartTime = CLOSE_AT.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00');
  }
  return shifted;
};
const eventAddress = (tag: string) => `https://polymarket.com/event/ucl-bay-bog-${tag}`;
const marketAddress = (tag: string) => `${eventAddress(tag)}/ucl-bay-bog-${tag}-draw`;

class TestFacilitator implements PaymentFacilitator {
  readonly name = 'test-facilitator';
  readonly mode = 'simulated' as const;
  settleCalls = 0;
  async prepare(requirements: PaymentRequirements) { return { ...requirements, extra: { ...requirements.extra, feePayer: '0.0.7000' } }; }
  async verify() { return { valid: true, payer: '0.0.99' }; }
  async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
    this.settleCalls++;
    return { transaction: `test-tx:${requirements.extra.nonce}`, payer: '0.0.99', network: requirements.network, mode: this.mode };
  }
}

/**
 * Records every creation id it is asked for, so a retry that recreated a market — or created one
 * under the wrong id — would be visible. `failAt` makes one child's first attempt fail.
 */
class RecordingDeployer implements MarketDeployer {
  readonly resolver = '0x6666666666666666666666666666666666666666' as const;
  readonly created = new Map<string, Address>();
  readonly broadcasts: string[] = [];
  failAt?: number;
  // A market address belongs to at most one event, so every run needs its own address space.
  private readonly prefix = randomUUID().replace(/-/g, '').slice(0, 34);
  private next = 1;
  private key(requestId: string, position?: number) { return creationId(requestId, position); }
  async find(requestId: string, position?: number) { return this.created.get(this.key(requestId, position)); }
  async create(plan: MarketPlan) {
    const key = this.key(plan.requestId, plan.position);
    const existing = this.created.get(key);
    if (existing) return { market: existing, alreadyExisted: true };
    if (this.failAt !== undefined && plan.position === this.failAt) {
      this.failAt = undefined;
      throw new Error('simulated_rpc_failure');
    }
    this.broadcasts.push(key);
    const market = `0x${this.prefix}${String(this.next++).padStart(6, '0')}` as Address;
    this.created.set(key, market);
    return { market, transactionHash: `0x${'ab'.repeat(32)}` as const, alreadyExisted: false };
  }
}

const unavailableVerifier: HumanVerifier = { name: 'unavailable', available: false, reason: 'no access', verify: async () => { throw new Error('unavailable'); } };
const context = async () => ({ available: true, context: { indexedBlock: 100, markets: [] } });

function service(tag: string, overrides: { facilitator?: PaymentFacilitator; deployer?: MarketDeployer; gamma?: GammaClient } = {}) {
  return new CreationService({
    db, provider: new DevelopmentDraftProvider(), payments, world, context, imports,
    verifier: unavailableVerifier,
    facilitator: overrides.facilitator ?? new TestFacilitator(),
    deployer: overrides.deployer,
    gamma: overrides.gamma ?? new GammaClient(POLYMARKET_API_ORIGIN, async () => Response.json(sourceEvent(tag))),
  });
}

/** A client that answers a market address the way Gamma does: the market, then its event. */
const focusedGamma = (tag: string) => new GammaClient(POLYMARKET_API_ORIGIN, async url =>
  Response.json(url.includes('/markets/slug/')
    ? { id: `3977564-${tag}-1`, slug: `ucl-bay-bog-${tag}-draw`, events: [{ slug: `ucl-bay-bog-${tag}` }] }
    : sourceEvent(tag)));

const requests: string[] = [];
const events: string[] = [];
async function track<T extends { id: string; eventId: string | null }>(request: T): Promise<T> {
  requests.push(request.id);
  if (request.eventId) events.push(request.eventId);
  return request;
}

test.after(async () => {
  if (requests.length) await db.creationRequest.deleteMany({ where: { id: { in: requests } } });
  if (events.length) {
    await db.marketResolution.deleteMany({ where: { eventId: { in: events } } });
    await db.marketEvent.deleteMany({ where: { id: { in: events } } });
  }
  await db.adminAudit.deleteMany({ where: { actor: 'events-test@horizon.local' } });
  await db.$disconnect();
});

const payFor = async (target: CreationService, id: string, token: string) => {
  const issued = await target.requirePayment(id, token, 'https://horizon.local/pay');
  const requirements = await target.requirements(issued.payment);
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: requirements, payload: { payer: '0.0.99', nonce: randomUUID() } })).toString('base64');
  return { settled: await target.submitPayment(id, token, header, 'https://horizon.local/pay'), requirements };
};

test('an imported event previews before anything is written, charged or deployed', { timeout: 30_000 }, async () => {
  const before = await db.marketEvent.count();
  const preview = await service('preview').previewImport(eventAddress('preview'));
  assert.equal(preview.source.kind, 'event');
  assert.equal(preview.preview.exclusivity, 'EXCLUSIVE');
  assert.equal(preview.preview.children.length, 3);
  assert.equal(preview.importPolicy, 'definitions_only');
  // Three markets at the standalone price, stated before approval, with the discount shown too.
  assert.equal(preview.quote.quantity, 3);
  assert.equal(preview.quote.totalUnits, '300000000');
  assert.equal(preview.quote.discountedTotalUnits, '150000000');
  assert.equal(preview.existing, undefined);
  assert.equal(await db.marketEvent.count(), before, 'a preview must not write anything');
});

test('an import creates one event, one payment and one market per selected child', { timeout: 60_000 }, async () => {
  const facilitator = new TestFacilitator();
  const deployer = new RecordingDeployer();
  const target = service('full', { facilitator, deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('full'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  const token = result.token!;
  assert.equal(result.request.kind, 'GROUP');
  assert.equal(result.request.children.length, 3);
  assert.equal(result.request.event?.sourceProvider, 'polymarket');
  assert.equal(result.request.event?.sourceEventId, '931729-full');
  assert.equal(result.request.event?.exclusivity, 'EXCLUSIVE');
  assert.equal(result.request.event?.outcomesComplete, true);
  assert.deepEqual(result.request.event?.members.map(member => member.outcomeLabel),
    result.request.children.map(child => child.outcomeLabel));
  // Membership is durable metadata; no member is a market until a market address is recorded.
  assert.ok(result.request.event!.members.every(member => member.marketAddress === null));

  // Approval is bound to the plan the server holds, not to whatever the client sends.
  await assert.rejects(() => target.approve(id, token, 'f'.repeat(64)),
    (error: unknown) => error instanceof WorkflowError && error.code === 'draft_hash_mismatch');
  const approved = await target.approve(id, token, result.request.draftHash!);
  assert.equal(approved.status, 'APPROVED');

  const { settled } = await payFor(target, id, token);
  assert.equal(settled.request.status, 'PAID');
  // One charge for the whole group, at three times the standalone price.
  assert.equal(settled.payment.amountUnits, '300000000');
  assert.equal(facilitator.settleCalls, 1);

  const created = await target.runCreation(id);
  assert.equal(created.status, 'CREATED');
  const children = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  assert.deepEqual(children.map(child => child.status), ['CREATED', 'CREATED', 'CREATED']);
  assert.equal(new Set(children.map(child => child.marketAddress)).size, 3, 'each child is its own market');
  const event = await db.marketEvent.findUniqueOrThrow({ where: { id: result.request.eventId! }, include: { members: { orderBy: { position: 'asc' } } } });
  assert.equal(event.status, 'ACTIVE');
  // Membership stores the canonical lower-case address, which is what the market page's lookup
  // and the unique index across every event both rely on.
  assert.deepEqual(event.members.map(member => member.marketAddress),
    children.map(child => child.marketAddress!.toLowerCase()));
  assert.ok(event.members.every(member => member.marketAddress === member.marketAddress!.toLowerCase()));
  // Three markets, one notice: the creator asked for an event and is told about the event, once it is whole.
  const notices = await db.notification.findMany({ where: { requestId: id } });
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.kind, 'event.created');
  assert.equal(notices[0]!.href, `/events/${event.slug}`);
  assert.equal(notices[0]!.body, `${event.title} · 3 markets`);
  assert.deepEqual(notices[0]!.sources, ['receipt']);
  // Each child still told the creator's open tab as it deployed; only the last message carries the notice.
  const messages = await db.liveEvent.findMany({ where: { type: 'creation.updated', topic: creationTopic(id) }, orderBy: { id: 'asc' } });
  assert.deepEqual(messages.map(message => (message.payload as { position?: number }).position), [0, 1, 2, undefined]);
  assert.deepEqual(messages.map(message => 'notification' in (message.payload as object)), [false, false, false, true]);

  // Re-running the finished job deploys nothing and charges nothing.
  const rerun = await target.runCreation(id);
  assert.equal(rerun.status, 'CREATED');
  assert.equal(deployer.broadcasts.length, 3);
  assert.equal(facilitator.settleCalls, 1);
  assert.equal(await db.notification.count({ where: { requestId: id } }), 1);
});

test('a second import of the same source event links to what exists instead of charging again', { timeout: 30_000 }, async () => {
  const target = service('dup', { deployer: new RecordingDeployer() });
  const first = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('dup'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await track(first.request);

  // A retry with the same key is the same request, exactly as a standalone draft retry is.
  const replayed = await target.createImport({ idempotencyKey: first.request.idempotencyKey, url: eventAddress('dup'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(replayed.ok, true);
  if (replayed.ok) {
    assert.equal(replayed.replay, true);
    assert.equal(replayed.request.id, first.request.id);
    // A replay never re-issues the bearer token: the first caller keeps sole control.
    assert.equal(replayed.token, undefined);
  }

  // A different caller importing the same page is told what already exists.
  const duplicate = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('dup'), requesterKind: 'agent', requester: 'agent-two' });
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.reason, 'import_in_progress');
  assert.equal(duplicate.existing?.eventId, first.request.eventId);
  assert.equal(duplicate.existing?.slug, first.request.event?.slug);
  assert.equal(await db.creationRequest.count({ where: { eventId: first.request.eventId } }), 1);

  // A preview reports the same thing, before anybody commits to paying.
  const preview = await target.previewImport(eventAddress('dup'));
  assert.equal(preview.existing?.eventId, first.request.eventId);
  assert.equal(preview.existing?.inProgress, true);
});

test('concurrent imports of one source event produce exactly one event and one payable request', { timeout: 30_000 }, async () => {
  const target = service('race', { deployer: new RecordingDeployer() });
  const attempts = await Promise.all(Array.from({ length: 4 }, () =>
    target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('race'), requesterKind: 'browser', requester: REQUESTER })
      .then(result => result, error => ({ ok: false as const, reason: `threw:${String(error)}`, preview: undefined, existing: undefined }))));
  const winners = attempts.filter(attempt => attempt.ok);
  assert.equal(winners.length, 1, `exactly one import may win, got ${attempts.map(a => a.ok ? 'ok' : a.reason).join(', ')}`);
  const winner = winners[0]!;
  if (!winner.ok) return;
  await track(winner.request);
  for (const loser of attempts.filter(attempt => !attempt.ok)) {
    assert.equal(loser.ok ? '' : loser.reason, 'import_in_progress');
  }
  assert.equal(await db.marketEvent.count({ where: { sourceProvider: 'polymarket', sourceEventId: '931729-race' } }), 1);
  assert.equal(await db.creationRequest.count({ where: { eventId: winner.request.eventId } }), 1);

  // Discarding the request releases the source event so the page can be imported again.
  await target.abandon(winner.request.id, winner.token!);
  assert.equal(await db.marketEvent.count({ where: { sourceProvider: 'polymarket', sourceEventId: '931729-race' } }), 0);
});

test('changing the selection reprices the group and invalidates any approval taken before it', { timeout: 30_000 }, async () => {
  const target = service('select', { deployer: new RecordingDeployer() });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('select'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  const token = result.token!;
  const initialHash = result.request.draftHash!;

  const narrowed = await target.selectChildren(id, token, [0, 2]);
  assert.notEqual(narrowed.draftHash, initialHash, 'a changed selection must change the plan hash');
  assert.deepEqual(narrowed.children.map(child => child.status), ['PENDING', 'SKIPPED', 'PENDING']);
  // Two of three outcomes is not the source's full outcome set, and is not labelled as one.
  assert.equal(narrowed.event?.outcomesComplete, false);

  // The hash a reviewer saw before the change no longer approves anything.
  await assert.rejects(() => target.approve(id, token, initialHash),
    (error: unknown) => error instanceof WorkflowError && error.code === 'draft_hash_mismatch');
  await assert.rejects(() => target.selectChildren(id, token, []),
    (error: unknown) => error instanceof WorkflowError && error.code === 'import_selection_empty');
  await assert.rejects(() => target.selectChildren(id, token, [9]),
    (error: unknown) => error instanceof WorkflowError && error.code === 'import_selection_unsupported');

  await target.approve(id, token, narrowed.draftHash!);
  await assert.rejects(() => target.selectChildren(id, token, [0]),
    (error: unknown) => error instanceof WorkflowError && error.code === 'selection_after_approval');
  const { settled } = await payFor(target, id, token);
  // Two markets, so two creation charges — not three, and not one.
  assert.equal(settled.payment.amountUnits, '200000000');

  const deployed = await target.runCreation(id);
  assert.equal(deployed.status, 'CREATED');
  const children = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  assert.deepEqual(children.map(child => child.status), ['CREATED', 'SKIPPED', 'CREATED']);
  assert.equal(children[1]!.marketAddress, null);
  // The deselected child is not part of the event either, so nothing lists an untradeable outcome.
  const members = await db.eventMarket.findMany({ where: { eventId: result.request.eventId! }, orderBy: { position: 'asc' } });
  assert.deepEqual(members.map(member => member.position), [0, 2]);
});

test('a partial deployment failure keeps what was created, charges nothing more, and finishes on retry', { timeout: 60_000 }, async () => {
  const facilitator = new TestFacilitator();
  const deployer = new RecordingDeployer();
  const target = service('partial', { facilitator, deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('partial'), requesterKind: 'agent', requester: 'agent-partial' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  const token = result.token!;
  await target.approve(id, token, result.request.draftHash!);
  await payFor(target, id, token);
  assert.equal(facilitator.settleCalls, 1);

  deployer.failAt = 1;
  await assert.rejects(() => target.runCreation(id), (error: unknown) => error instanceof WorkflowError && error.code === 'group_partially_created');
  const afterFailure = await db.creationRequest.findUniqueOrThrow({ where: { id }, include: { children: { orderBy: { position: 'asc' } } } });
  assert.equal(afterFailure.status, 'FAILED');
  assert.deepEqual(afterFailure.children.map(child => child.status), ['CREATED', 'FAILED', 'CREATED']);
  const survivors = afterFailure.children.filter(child => child.marketAddress).map(child => child.marketAddress);
  assert.equal(survivors.length, 2);
  assert.equal(deployer.broadcasts.length, 2);
  // Two of three exist; the event is not ready, so nothing has been announced.
  assert.equal(await db.notification.count({ where: { requestId: id } }), 0);

  // The retry deploys only what is missing. Nothing already created is recreated, and the
  // settled payment is neither re-issued nor re-charged.
  const retried = await target.runCreation(id);
  assert.equal(retried.status, 'CREATED');
  assert.equal(deployer.broadcasts.length, 3);
  assert.equal(facilitator.settleCalls, 1);
  const finished = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  assert.deepEqual(finished.map(child => child.status), ['CREATED', 'CREATED', 'CREATED']);
  assert.deepEqual(finished.filter(child => survivors.includes(child.marketAddress)).map(child => child.position), [0, 2]);
  assert.equal(new Set(finished.map(child => child.marketAddress)).size, 3);
  const payment = await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } });
  assert.equal(payment.status, 'SETTLED');
  assert.equal(payment.amountUnits, '300000000');
  assert.equal(await db.notification.count({ where: { requestId: id, kind: 'event.created' } }), 1);
});

test('a run interrupted mid-deployment resumes instead of stranding the paid request', { timeout: 60_000 }, async () => {
  const facilitator = new TestFacilitator();
  const deployer = new RecordingDeployer();
  const target = service('interrupted', { facilitator, deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('interrupted'), requesterKind: 'agent', requester: 'agent-interrupted' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  await target.approve(id, result.token!, result.request.draftHash!);
  await payFor(target, id, result.token!);

  // The shape a worker leaves behind when it dies mid-run: the request and the child it had
  // started are CREATING, and no catch ever ran to record a failure.
  const first = await db.creationChild.findFirstOrThrow({ where: { requestId: id }, orderBy: { position: 'asc' } });
  await db.creationRequest.update({ where: { id }, data: { status: 'CREATING' } });
  await db.creationChild.update({ where: { id: first.id }, data: { status: 'CREATING', attempts: 1 } });

  const resumed = await target.runCreation(id);
  assert.equal(resumed.status, 'CREATED');
  const children = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  assert.deepEqual(children.map(child => child.status), ['CREATED', 'CREATED', 'CREATED']);
  assert.equal(new Set(children.map(child => child.marketAddress)).size, 3);
  // The interrupted run broadcast nothing, so the resume deploys all three and charges nothing more.
  assert.equal(deployer.broadcasts.length, 3);
  assert.equal(facilitator.settleCalls, 1);
});

test('a market address imports the event with only that market selected', { timeout: 30_000 }, async () => {
  const target = service('single', { gamma: focusedGamma('single'), deployer: new RecordingDeployer() });
  const preview = await target.previewImport(marketAddress('single'));
  assert.equal(preview.source.kind, 'market');
  assert.equal(preview.quote.quantity, 1);
  assert.equal(preview.quote.totalUnits, '100000000');
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: marketAddress('single'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await track(result.request);
  assert.deepEqual(result.request.children.map(child => child.status), ['SKIPPED', 'PENDING', 'SKIPPED']);
  // One of three outcomes is never presented as the whole outcome set.
  assert.equal(result.request.event?.outcomesComplete, false);
  // The siblings are still recorded, so the group context is visible while reviewing.
  assert.equal(result.request.event?.members.length, 3);
});

test('a manually authored group behaves like an import without a source', { timeout: 30_000 }, async () => {
  const target = service('manual', { deployer: new RecordingDeployer() });
  const result = await target.createGroup({
    idempotencyKey: randomUUID(), requesterKind: 'browser', requester: REQUESTER,
    event: { title: 'Horizon demo derby', category: 'Sports', exclusivity: 'COLLECTION' },
    children: [
      { question: 'Will the home side win the Horizon demo derby?', outcomeLabel: 'Home win' },
      { question: 'Will the away side win the Horizon demo derby?', outcomeLabel: 'Away win' },
    ],
  });
  const { id } = await track(result.request);
  assert.equal(result.request.kind, 'GROUP');
  assert.equal(result.request.event?.sourceProvider, 'horizon');
  assert.equal(result.request.event?.sourceEventId, null);
  assert.equal(result.request.children.length, 2);
  assert.equal(result.request.draftProvider, 'horizon-deterministic');
  await target.approve(id, result.token!, result.request.draftHash!);
  const { settled } = await payFor(target, id, result.token!);
  assert.equal(settled.payment.amountUnits, '200000000');
  const created = await target.runCreation(id);
  assert.equal(created.status, 'CREATED');
});

test('a standalone request is untouched by grouping: no event, no children, one market, one charge', { timeout: 30_000 }, async () => {
  const facilitator = new TestFacilitator();
  const deployer = new RecordingDeployer();
  const target = service('solo', { facilitator, deployer });
  const draft = await target.createDraft({
    idempotencyKey: randomUUID(), question: 'Will a standalone Horizon market still create exactly one market?',
    requesterKind: 'browser', requester: REQUESTER,
  });
  const { id } = await track(draft.request);
  assert.equal(draft.request.kind, 'SINGLE');
  assert.equal(draft.request.eventId, null);
  assert.equal(draft.request.children.length, 0);
  await target.approve(id, draft.token!, draft.request.draftHash!);
  const { settled } = await payFor(target, id, draft.token!);
  assert.equal(settled.payment.amountUnits, '100000000');
  const created = await target.runCreation(id);
  assert.equal(created.status, 'CREATED');
  assert.ok(created.marketAddress);
  // The creation id of a standalone market is derived exactly as it was before events existed,
  // so a market created by an older release is still found rather than deployed a second time.
  assert.deepEqual(deployer.broadcasts, [creationId(id)]);
  assert.equal(await db.creationChild.count({ where: { requestId: id } }), 0);
  assert.equal(await db.eventMarket.count({ where: { marketAddress: created.marketAddress } }), 0);
});

test('an exclusive group refuses a second winner through the resolution workflow', { timeout: 60_000 }, async () => {
  const deployer = new RecordingDeployer();
  const target = service('resolve', { deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('resolve'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  await target.approve(id, result.token!, result.request.draftHash!);
  await payFor(target, id, result.token!);
  await target.runCreation(id);
  const children = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  const [first, second] = children.map(child => child.marketAddress as Address);

  const events = new EventService(db);
  const membership = await events.forMarket(first!);
  assert.equal(membership?.event.exclusivity, 'EXCLUSIVE');
  assert.equal(membership?.member.outcomeLabel, 'FC Bayern München');

  // No market service here, so the closed/resolved pre-checks are skipped and the group rule is
  // exercised on its own. Resolution submission is not attempted; only the recorded intent matters.
  const queued: string[] = [];
  const admin = new AdminService({ db, events, enqueueResolution: async resolutionId => { queued.push(resolutionId); } });
  const recorded = await admin.requestResolution('events-test@horizon.local', first!, 'YES', 'Official UEFA match report for the fixture.');
  assert.equal(recorded.result, 'YES');
  assert.equal(recorded.eventId, result.request.eventId);
  assert.deepEqual(queued, [recorded.id]);

  // A second YES contradicts the winner already queued for a sibling.
  await assert.rejects(() => admin.requestResolution('events-test@horizon.local', second!, 'YES', 'A contradictory second winner.'),
    (error: unknown) => error instanceof WorkflowError && error.code === 'exclusive_group_winner_pending');
  // NO and INVALID are never blocked: a void or cancelled event has to settle across the group.
  for (const outcome of ['NO', 'INVALID'] as const) {
    const sibling = await admin.requestResolution('events-test@horizon.local', second!, outcome, `A ${outcome} result for the losing side.`);
    assert.equal(sibling.market, second!.toLowerCase());
    await db.marketResolution.deleteMany({ where: { market: second!.toLowerCase() } });
  }
  const disclosure = (await admin.overview()).resolverModel.groupConsistency;
  assert.equal(disclosure.enforcement, 'backend_only');
  assert.match(disclosure.note, /contracts hold no notion of a group/);

  // A standalone market is never subject to a group rule.
  const standalone = new AdminService({ db, events, enqueueResolution: async () => undefined });
  const lone = '0x9999999999999999999999999999999999999999' as Address;
  const loneRecord = await standalone.requestResolution('events-test@horizon.local', lone, 'YES', 'A standalone market resolves on its own evidence.');
  assert.equal(loneRecord.eventId, null);
  await db.marketResolution.deleteMany({ where: { market: lone.toLowerCase() } });
});

test('a whole exclusive group can be voided INVALID, and an already resolved market is not resubmitted', { timeout: 60_000 }, async () => {
  const tag = 'void';
  const deployer = new RecordingDeployer();
  const target = service(tag, { deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress(tag), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  await target.approve(id, result.token!, result.request.draftHash!);
  await payFor(target, id, result.token!);
  await target.runCreation(id);
  const children = await db.creationChild.findMany({ where: { requestId: id }, orderBy: { position: 'asc' } });
  const markets = children.map(child => child.marketAddress as Address);

  // Records what it was asked to submit, and reports a market that is already resolved on chain
  // the way the real submitter does: without broadcasting anything.
  const resolved = new Set<string>();
  const submissions: { market: string; result: string }[] = [];
  const submitter = {
    resolver: '0x6666666666666666666666666666666666666666' as const,
    async submit(market: Address, outcome: 'YES' | 'NO' | 'INVALID', evidence: string) {
      assert.ok(evidence.length >= 10);
      if (resolved.has(market.toLowerCase())) return { alreadyResolved: true };
      resolved.add(market.toLowerCase());
      submissions.push({ market: market.toLowerCase(), result: outcome });
      return { transactionHash: `0x${'cd'.repeat(32)}` as const, alreadyResolved: false };
    },
  };
  const events = new EventService(db);
  const admin = new AdminService({ db, events, submitter, enqueueResolution: async () => undefined });
  const evidence = 'Market created in error and never intended for trading; voided by the disclosed Horizon resolver.';

  // Every sibling of an exclusive group can be voided. The one-winner rule constrains YES only:
  // a cancelled or void underlying event has to be settleable across the whole group, and INVALID
  // pays 0.5 USDC per outcome token on each of them.
  for (const market of markets) {
    const record = await admin.requestResolution('events-test@horizon.local', market, 'INVALID', evidence);
    assert.equal(record.result, 'INVALID');
    assert.equal(record.eventId, result.request.eventId);
    const submitted = await admin.runResolution(record.id);
    assert.equal(submitted.status, 'SUBMITTED');
    assert.ok(submitted.txHash);
  }
  assert.deepEqual(submissions.map(entry => entry.result), ['INVALID', 'INVALID', 'INVALID']);
  assert.deepEqual(new Set(submissions.map(entry => entry.market)), new Set(markets.map(market => market.toLowerCase())));

  // Re-running is safe: the recorded resolution is already SUBMITTED, so nothing is broadcast again.
  const records = await db.marketResolution.findMany({ where: { eventId: result.request.eventId! } });
  for (const record of records) assert.equal((await admin.runResolution(record.id)).status, 'SUBMITTED');
  assert.equal(submissions.length, 3, 'a replayed resolution must not submit a second transaction');

  // And a fresh request for a market already resolved on chain records the intent but broadcasts
  // nothing, which is what makes a repeated recovery run harmless.
  await db.marketResolution.deleteMany({ where: { market: markets[0]!.toLowerCase() } });
  const again = await admin.requestResolution('events-test@horizon.local', markets[0]!, 'INVALID', evidence);
  assert.equal((await admin.runResolution(again.id)).status, 'SUBMITTED');
  assert.equal(submissions.length, 3);
});

test('events read back with Horizon-derived state only, and grouped children are never listed twice', { timeout: 60_000 }, async () => {
  const deployer = new RecordingDeployer();
  const target = service('browse', { deployer });
  const result = await target.createImport({ idempotencyKey: randomUUID(), url: eventAddress('browse'), requesterKind: 'browser', requester: REQUESTER });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { id } = await track(result.request);
  await target.approve(id, result.token!, result.request.draftHash!);
  await payFor(target, id, result.token!);
  await target.runCreation(id);

  const events = new EventService(db);
  const listed = await events.list();
  const event = listed.find(entry => entry.id === result.request.eventId);
  assert.ok(event, 'a deployed event is browsable');
  assert.equal(event!.exclusivity, 'EXCLUSIVE');
  assert.equal(event!.exclusivityEnforcement, 'backend_only');
  assert.equal(event!.source.provider, 'polymarket');
  assert.equal(event!.source.url, eventAddress('browse'));
  assert.equal(event!.children.length, 3);
  // No market data was supplied, so nothing invents prices for the children.
  assert.ok(event!.children.every(child => child.market === null && child.marketAddress));
  assert.equal(event!.stats.live, 0);
  assert.equal(event!.stats.collateral, '0');
  assert.equal(JSON.stringify(event).includes('outcomePrices'), false);

  const grouped = await events.groupedAddresses();
  for (const child of event!.children) assert.ok(grouped.has(child.marketAddress!.toLowerCase()));
  assert.equal((await events.bySlug(event!.slug))?.id, event!.id);
  assert.equal(await events.bySlug('no-such-event'), null);

  // A draft event, with nothing deployed, is not browsable at all.
  const draftOnly = await target.createGroup({
    idempotencyKey: randomUUID(), requesterKind: 'browser', requester: REQUESTER,
    event: { title: 'Unpaid draft group', category: 'Testing', exclusivity: 'COLLECTION' },
    children: [{ question: 'Will this unpaid draft group ever be listed for browsing?', outcomeLabel: 'Listed' }],
  });
  await track(draftOnly.request);
  assert.equal((await events.list()).some(entry => entry.id === draftOnly.request.eventId), false);
});

test('the HTTP surface previews, imports, selects, prices and browses an event', { timeout: 60_000 }, async () => {
  const tag = 'http';
  // The API origin is configuration, so the whole import path is exercised through it rather than
  // through an injected client: a local stub stands in for Gamma exactly as production would use it.
  const source = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('/markets/slug/')
      ? { id: `3977564-${tag}-1`, slug: `ucl-bay-bog-${tag}-draw`, events: [{ slug: `ucl-bay-bog-${tag}` }] }
      : sourceEvent(tag)));
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as { port: number }).port;

  const password = `test-${randomUUID()}`;
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: url!, ADMIN_EMAIL: 'events-test@horizon.local',
    ADMIN_PASSWORD_HASH: await hashPassword(password), SESSION_SECRET: randomUUID() + randomUUID(),
    HEDERA_PAYMENT_MODE: 'simulated', HEDERA_RECEIVER_ACCOUNT_ID: '0.0.4242', AI_PROVIDER: 'development',
    MARKET_SYNC_ENABLED: 'false', POLYMARKET_API_ORIGIN: `http://127.0.0.1:${sourcePort}`,
  });
  assert.equal(config.imports.polymarketApiOrigin, `http://127.0.0.1:${sourcePort}`);
  const built = await createApp(config, db);
  const server = built.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const json = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  try {
    const configured = await (await json('/api/config')).json() as {
      events: { sharedCollateral: boolean; negativeRiskConversion: boolean; imports: { available: boolean; providers: string[]; policy: string } };
      resolution: { groupConsistency: string };
    };
    assert.equal(configured.events.imports.available, true);
    assert.deepEqual(configured.events.imports.providers, ['polymarket']);
    assert.equal(configured.events.imports.policy, 'definitions_only');
    // Deferred on purpose, and stated as deferred rather than implied.
    assert.equal(configured.events.sharedCollateral, false);
    assert.equal(configured.events.negativeRiskConversion, false);
    assert.equal(configured.resolution.groupConsistency, 'backend_only');

    // An address that is not a Polymarket page never reaches the network.
    for (const [bad, status] of [['https://evil.example/event/x', 400], ['https://polymarket.com/profile/x', 400]] as const) {
      const refused = await post('/api/creation/imports/preview', { url: bad });
      assert.equal(refused.status, status);
      assert.match(((await refused.json()) as { error: string }).error, /^import_url_/);
    }

    const previewed = await post('/api/creation/imports/preview', { url: eventAddress(tag) });
    assert.equal(previewed.status, 200);
    const preview = await previewed.json() as {
      preview: { title: string; exclusivity: string; children: { position: number; supported: boolean; preselected: boolean }[] };
      quote: { quantity: number; totalUnits: string }; existing?: unknown; importPolicy: string;
    };
    assert.equal(preview.preview.exclusivity, 'EXCLUSIVE');
    assert.equal(preview.preview.children.length, 3);
    assert.equal(preview.quote.totalUnits, '300000000');
    assert.equal(preview.importPolicy, 'definitions_only');
    assert.equal(preview.existing, undefined);

    const imported = await post('/api/creation/imports', { url: eventAddress(tag), requesterKind: 'browser', requester: REQUESTER },
      { 'idempotency-key': randomUUID() });
    assert.equal(imported.status, 201);
    const body = await imported.json() as {
      request: { id: string; kind: string; draftHash: string; children: { position: number; status: string }[];
        event: { slug: string; exclusivityEnforcement: string; source: { provider: string } };
        groupQuote: { quantity: number; totalUnits: string } };
      accessToken: string;
    };
    const request = await db.creationRequest.findUniqueOrThrow({ where: { id: body.request.id } });
    await track(request);
    assert.equal(body.request.kind, 'GROUP');
    assert.equal(body.request.event.source.provider, 'polymarket');
    assert.equal(body.request.event.exclusivityEnforcement, 'backend_only');
    assert.equal(body.request.groupQuote.totalUnits, '300000000');
    const auth = { authorization: `Bearer ${body.accessToken}` };

    // A second import of the same page is refused with links rather than a second bill.
    const duplicate = await post('/api/creation/imports', { url: eventAddress(tag), requesterKind: 'browser', requester: 'someone-else' },
      { 'idempotency-key': randomUUID() });
    assert.equal(duplicate.status, 409);
    assert.equal(((await duplicate.json()) as { error: string }).error, 'import_in_progress');

    // Narrowing the selection reprices the group and rewrites the plan hash.
    const selected = await post(`/api/creation/requests/${body.request.id}/selection`, { positions: [0, 2] }, auth);
    assert.equal(selected.status, 200);
    const narrowed = ((await selected.json()) as { request: typeof body.request }).request;
    assert.notEqual(narrowed.draftHash, body.request.draftHash);
    assert.equal(narrowed.groupQuote.totalUnits, '200000000');
    const stale = await post(`/api/creation/requests/${body.request.id}/approval`, { draftHash: body.request.draftHash }, auth);
    assert.equal(stale.status, 422);
    assert.equal(((await stale.json()) as { error: string }).error, 'draft_hash_mismatch');

    const approved = await post(`/api/creation/requests/${body.request.id}/approval`, { draftHash: narrowed.draftHash }, auth);
    assert.equal(approved.status, 200);
    const required = await post(`/api/creation/requests/${body.request.id}/payment`, {}, auth);
    assert.equal(required.status, 402);
    const requirements = await required.json() as { accepts: { amount: string; extra: { nonce: string } }[] };
    // Two selected markets, so twice the standalone charge, in one x402 request.
    assert.equal(requirements.accepts[0]!.amount, '200000000');

    // Browsing works while nothing is deployed: an event with no markets yet is not listed.
    const events = await (await json('/api/events')).json() as { events: { slug: string }[] };
    assert.equal(events.events.some(entry => entry.slug === body.request.event.slug), false);
    assert.equal((await json(`/api/events/${body.request.event.slug}`)).status, 200);
    assert.equal((await json('/api/events/no-such-event')).status, 404);
    assert.equal((await json('/api/events/Not-A-Slug')).status, 400);
    const detail = await (await json(`/api/events/${body.request.event.slug}`)).json() as {
      event: { children: { marketAddress: string | null; market: unknown }[]; source: { url: string }; exclusivityEnforcement: string };
      resolution: { enforcement: string; note: string };
    };
    assert.equal(detail.event.source.url, eventAddress(tag));
    assert.equal(detail.resolution.enforcement, 'backend_only');
    assert.match(detail.resolution.note, /market contracts do not enforce that/);
    // Nothing is deployed, so no child pretends to be a market.
    assert.ok(detail.event.children.every(child => child.marketAddress === null && child.market === null));

    // Discarding an unpaid import releases the source page for a future import.
    const discarded = await post(`/api/creation/requests/${body.request.id}/abandonment`, {}, auth);
    assert.equal(discarded.status, 200);
    assert.equal(await db.marketEvent.count({ where: { sourceEventId: `931729-${tag}` } }), 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => source.close(() => resolve()));
    await built.close();
  }
});
