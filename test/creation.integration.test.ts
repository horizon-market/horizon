import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { loadConfig, type Config } from '../src/config.js';
import { CreationService, WorkflowError } from '../src/creation/service.js';
import { draftHash, draftSchema, type MarketDraft } from '../src/creation/types.js';
import { DevelopmentDraftProvider } from '../src/creation/ai.js';
import { AdminService } from '../src/admin/service.js';
import { SettlementAmbiguousError, type PaymentFacilitator, type PaymentPayload, type PaymentRequirements } from '../src/payments/x402.js';
import type { HumanVerifier } from '../src/world/verifier.js';
import type { MarketDeployer } from '../src/creation/onchain.js';
import type { PaymentsConfig, WorldConfig } from '../src/config.js';

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
const MARKET = '0x5555555555555555555555555555555555555555' as const;

class CountingFacilitator implements PaymentFacilitator {
  readonly name = 'test-facilitator';
  readonly mode = 'simulated' as const;
  verifyCalls = 0; settleCalls = 0;
  constructor(private behaviour: 'settle' | 'ambiguous' | 'invalid' = 'settle') {}
  async prepare(requirements: PaymentRequirements) { return { ...requirements, extra: { ...requirements.extra, feePayer: '0.0.7000' } }; }
  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements) {
    this.verifyCalls++;
    return this.behaviour === 'invalid' ? { valid: false, reason: 'insufficient_funds' } : { valid: true, payer: '0.0.99' };
  }
  async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
    this.settleCalls++;
    if (this.behaviour === 'ambiguous') throw new SettlementAmbiguousError('facilitator timed out');
    return { transaction: `test-tx:${requirements.extra.nonce}`, payer: '0.0.99', network: requirements.network, mode: this.mode };
  }
}
class StubVerifier implements HumanVerifier {
  readonly name = 'stub-world';
  readonly available = true;
  readonly reason = 'test verifier';
  constructor(private nullifier: string) {}
  async verify() { return { nullifierHash: this.nullifier, credentialType: 'selfie', verifier: this.name }; }
}
class StubDeployer implements MarketDeployer {
  readonly resolver = '0x6666666666666666666666666666666666666666' as const;
  calls = 0;
  constructor(private existing?: typeof MARKET) {}
  async find() { return this.existing; }
  async create() {
    this.calls++;
    if (this.existing) return { market: this.existing, alreadyExisted: true };
    this.existing = MARKET;
    return { market: MARKET, transactionHash: `0x${'ab'.repeat(32)}` as const, alreadyExisted: false };
  }
}

const context = async () => ({ available: true, context: { indexedBlock: 100, markets: [] } });
function service(overrides: { facilitator?: PaymentFacilitator; verifier?: HumanVerifier; deployer?: MarketDeployer; enqueued?: string[] } = {}) {
  return new CreationService({
    db, provider: new DevelopmentDraftProvider(), payments, world, context,
    verifier: overrides.verifier ?? { name: 'unavailable', available: false, reason: 'no access', verify: async () => { throw new Error('unavailable'); } },
    facilitator: overrides.facilitator ?? new CountingFacilitator(),
    deployer: overrides.deployer, enqueue: async id => { overrides.enqueued?.push(id); },
  });
}
// Real x402 payloads carry a signed, single-use authorization; distinct payloads keep the
// cross-request replay index meaningful.
const payload = (requirements: PaymentRequirements, payer = '0.0.99', nonce = randomUUID()) => Buffer.from(JSON.stringify({
  x402Version: 2, accepted: requirements, payload: { payer, nonce },
})).toString('base64');
const worldProof = (nullifier: string) => ({
  protocol_version: '3.0' as const, nonce: randomUUID(), action: world.action,
  environment: 'staging' as const, user_presence_completed: true,
  responses: [{ identifier: 'selfie', signal_hash: `0x${'11'.repeat(32)}`, proof: `0x${'34'.repeat(64)}`,
    merkle_root: `0x${'12'.repeat(32)}`, nullifier }],
});
const RESOURCE = 'https://horizon.local/api/creation/requests/test/payment';
const created: string[] = [];
const nullifiers: string[] = [];

async function newRequest(target: CreationService, question = 'Will the Horizon Phase 3 workflow settle exactly one creation payment?') {
  const result = await target.createDraft({ idempotencyKey: randomUUID(), question, requesterKind: 'browser', requester: '0x243fBaeE0E81EfbC5900F0934f6f4Aa66a249D31' });
  created.push(result.request.id);
  return { id: result.request.id, token: result.token!, request: result.request };
}

test.after(async () => {
  if (created.length) await db.creationRequest.deleteMany({ where: { id: { in: created } } });
  if (nullifiers.length) await db.discountUsage.deleteMany({ where: { nullifierHash: { in: nullifiers } } });
  await db.marketResolution.deleteMany({ where: { market: MARKET.toLowerCase() } });
  await db.adminAudit.deleteMany({ where: { actor: 'test@horizon.local' } });
  await db.$disconnect();
});

test('a creation request is drafted, approved, paid once and created once', { timeout: 30_000 }, async () => {
  const facilitator = new CountingFacilitator();
  const deployer = new StubDeployer();
  const enqueued: string[] = [];
  const target = service({ facilitator, deployer, enqueued });
  const { id, token, request } = await newRequest(target);
  assert.equal(request.status, 'DRAFT');
  assert.equal(request.draftMode, 'development');
  const draft = draftSchema.parse(request.draft);

  // Payment cannot be requested before a human approves the exact draft.
  await assert.rejects(() => target.requirePayment(id, token, RESOURCE), (error: unknown) => error instanceof WorkflowError && error.code.startsWith('invalid_transition_draft'));
  await assert.rejects(() => target.approve(id, token, 'f'.repeat(64)), (error: unknown) => error instanceof WorkflowError && error.code === 'draft_hash_mismatch');
  const approved = await target.approve(id, token, draftHash(draft));
  assert.equal(approved.status, 'APPROVED');
  // Approving the same draft again is idempotent.
  assert.equal((await target.approve(id, token, draftHash(draft))).status, 'APPROVED');

  const issued = await target.requirePayment(id, token, RESOURCE);
  assert.equal(issued.replay, false);
  assert.equal(issued.payment.amountUnits, '100000000');
  assert.equal(issued.request.discountBps, 0);
  const requirements = await target.requirements(issued.payment);
  assert.equal(requirements.amount, '100000000');
  assert.equal(requirements.payTo, '0.0.4242');
  assert.equal(requirements.extra.feePayer, '0.0.7000');

  const settled = await target.submitPayment(id, token, payload(requirements), RESOURCE);
  assert.equal(settled.replay, false);
  assert.equal(settled.payment.status, 'SETTLED');
  assert.equal(settled.request.status, 'PAID');
  assert.deepEqual(enqueued, [id]);

  const finished = await target.runCreation(id);
  assert.equal(finished.status, 'CREATED');
  assert.equal(finished.marketAddress, MARKET);
  assert.equal(deployer.calls, 1);
  // Re-running the creation job returns the recorded market instead of deploying a second one.
  assert.equal((await target.runCreation(id)).status, 'CREATED');
  assert.equal(deployer.calls, 1);
});

test('payment retries are idempotent and never settle twice', { timeout: 30_000 }, async () => {
  const facilitator = new CountingFacilitator();
  const target = service({ facilitator });
  const { id, token, request } = await newRequest(target);
  await target.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  const first = await target.requirePayment(id, token, RESOURCE);
  // Repeated requirement requests reuse the same intent, nonce and amount.
  const second = await target.requirePayment(id, token, RESOURCE);
  assert.equal(second.replay, true);
  assert.equal(second.payment.nonce, first.payment.nonce);
  assert.equal(second.payment.amountUnits, first.payment.amountUnits);

  const requirements = await target.requirements(first.payment);
  const settled = await target.submitPayment(id, token, payload(requirements), RESOURCE);
  assert.equal(settled.payment.transactionRef, `test-tx:${first.payment.nonce}`);
  const replay = await target.submitPayment(id, token, payload(requirements), RESOURCE);
  assert.equal(replay.replay, true);
  const other = await target.submitPayment(id, token, payload(requirements, '0.0.1000'), RESOURCE);
  assert.equal(other.replay, true);
  assert.equal(facilitator.settleCalls, 1, 'a retried payment must not be settled again');
  assert.equal(facilitator.verifyCalls, 1);
  const stored = await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } });
  assert.equal(stored.attempts, 1);
  assert.equal(stored.status, 'SETTLED');
});

test('a payment authorization for different requirements is refused before the facilitator is called', { timeout: 30_000 }, async () => {
  const facilitator = new CountingFacilitator();
  const target = service({ facilitator });
  const { id, token, request } = await newRequest(target, 'Will Horizon refuse a payment authorization that was rewritten by its payer?');
  await target.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  const issued = await target.requirePayment(id, token, RESOURCE);
  const requirements = await target.requirements(issued.payment);
  // A payer who lowers the amount, redirects the receiver or reuses another nonce is rejected
  // by the server binding, so no facilitator verification or settlement is ever attempted.
  for (const rewritten of [{ ...requirements, amount: '1' }, { ...requirements, payTo: '0.0.9999' },
    { ...requirements, extra: { ...requirements.extra, nonce: 'someone-elses-nonce' } }]) {
    await assert.rejects(() => target.submitPayment(id, token, payload(rewritten), RESOURCE),
      (error: unknown) => error instanceof WorkflowError && error.code === 'payment_requirements_mismatch' && error.httpStatus === 400);
  }
  assert.equal(facilitator.verifyCalls, 0);
  assert.equal(facilitator.settleCalls, 0);
  const intent = await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } });
  assert.equal(intent.status, 'REQUIRED');
  assert.equal(intent.attempts, 0);
  // The honest authorization still settles afterwards.
  assert.equal((await target.submitPayment(id, token, payload(requirements), RESOURCE)).payment.status, 'SETTLED');
});

test('an ambiguous settlement parks the request for reconciliation instead of charging again', { timeout: 30_000 }, async () => {
  const facilitator = new CountingFacilitator('ambiguous');
  const target = service({ facilitator });
  const { id, token, request } = await newRequest(target);
  await target.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  const issued = await target.requirePayment(id, token, RESOURCE);
  const requirements = await target.requirements(issued.payment);
  await assert.rejects(() => target.submitPayment(id, token, payload(requirements), RESOURCE),
    (error: unknown) => error instanceof WorkflowError && error.code === 'payment_awaiting_reconciliation');
  assert.equal((await db.creationRequest.findUniqueOrThrow({ where: { id } })).status, 'PAYMENT_REVIEW');
  assert.equal((await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } })).failureCode,
    'settlement_ambiguous:facilitator timed out');
  await assert.rejects(() => target.submitPayment(id, token, payload(requirements), RESOURCE),
    (error: unknown) => error instanceof WorkflowError && error.code === 'payment_awaiting_reconciliation');
  assert.equal(facilitator.settleCalls, 1, 'reconciliation must not re-settle an ambiguous payment');

  const enqueued: string[] = [];
  const admin = new AdminService({ db, enqueueCreation: async requestId => { enqueued.push(requestId); } });
  const reconciled = await admin.reconcilePayment('test@horizon.local', (await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } })).id, 'SETTLED', '0.0.99@1757000000.000000000');
  assert.equal(reconciled.status, 'SETTLED');
  assert.equal((await db.creationRequest.findUniqueOrThrow({ where: { id } })).status, 'PAID');
  assert.deepEqual(enqueued, [id]);
  assert.equal(facilitator.settleCalls, 1);
});

test('a declined payment can be retried without leaving the request stuck', { timeout: 30_000 }, async () => {
  const facilitator = new CountingFacilitator('invalid');
  const target = service({ facilitator });
  const { id, token, request } = await newRequest(target);
  await target.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  const issued = await target.requirePayment(id, token, RESOURCE);
  const requirements = await target.requirements(issued.payment);
  await assert.rejects(() => target.submitPayment(id, token, payload(requirements), RESOURCE),
    (error: unknown) => error instanceof WorkflowError && error.code === 'payment_invalid');
  assert.equal(facilitator.settleCalls, 0);
  const failed = await db.paymentIntent.findUniqueOrThrow({ where: { requestId: id } });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureCode, 'insufficient_funds');
  await assert.rejects(() => target.submitPayment(id, token, 'not-a-payload', RESOURCE),
    (error: unknown) => error instanceof WorkflowError && error.httpStatus === 400);
});

test('the human discount applies once per credential per UTC day, after server verification', { timeout: 30_000 }, async () => {
  const nullifier = `0x${randomUUID().replace(/-/g, '')}`;
  nullifiers.push(nullifier);
  const target = service({ verifier: new StubVerifier(nullifier) });
  const first = await newRequest(target, 'Will the Horizon discount apply exactly once per credential per day?');
  await target.approve(first.id, first.token, draftHash(draftSchema.parse(first.request.draft)));
  const verified = await target.verify(first.id, first.token, worldProof(nullifier));
  assert.equal(verified.verification?.credentialType, 'selfie');
  const stored = await db.humanVerification.findUniqueOrThrow({ where: { requestId: first.id } });
  // Only the minimum verification result is retained.
  assert.deepEqual(Object.keys(stored).sort(), ['credentialType', 'id', 'nullifierHash', 'requestId', 'verifiedAt', 'verifier']);
  const discounted = await target.requirePayment(first.id, first.token, RESOURCE);
  assert.equal(discounted.payment.amountUnits, '50000000');
  assert.equal(discounted.request.discountBps, 5000);

  const second = await newRequest(target, 'Will the second Horizon request on the same credential pay the standard price?');
  await target.approve(second.id, second.token, draftHash(draftSchema.parse(second.request.draft)));
  await target.verify(second.id, second.token, worldProof(nullifier));
  const standard = await target.requirePayment(second.id, second.token, RESOURCE);
  assert.equal(standard.payment.amountUnits, '100000000');
  assert.equal(standard.request.discountBps, 0);
  assert.match(standard.request.discountNote, /already used its discounted creation today/);

  // Verification is refused once payment requirements exist, so the price cannot change afterwards.
  await assert.rejects(() => target.verify(second.id, second.token, worldProof(nullifier)),
    (error: unknown) => error instanceof WorkflowError && error.code === 'verification_after_payment_requirements');
});

test('an unavailable verifier reports the state and leaves the standard price in force', { timeout: 30_000 }, async () => {
  const target = service();
  const { id, token, request } = await newRequest(target, 'Will an unverified Horizon request pay the standard creation price?');
  await target.approve(id, token, draftHash(draftSchema.parse(request.draft)));
  await assert.rejects(() => target.verify(id, token, worldProof(`0x${'ab'.repeat(16)}`)),
    (error: unknown) => error instanceof WorkflowError && error.code === 'verification_unavailable' && error.httpStatus === 503);
  const issued = await target.requirePayment(id, token, RESOURCE);
  assert.equal(issued.payment.amountUnits, '100000000');
  assert.equal(issued.request.discountBps, 0);
});

test('another holder of a request id cannot read or advance it', { timeout: 30_000 }, async () => {
  const target = service();
  const { id, token, request } = await newRequest(target);
  const draft = draftSchema.parse(request.draft) as MarketDraft;
  for (const wrong of [undefined, '', 'not-the-token', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')]) {
    await assert.rejects(() => target.get(id, wrong), (error: unknown) => error instanceof WorkflowError && error.httpStatus === 401);
    await assert.rejects(() => target.approve(id, wrong, draftHash(draft)), (error: unknown) => error instanceof WorkflowError && error.httpStatus === 401);
    await assert.rejects(() => target.requirePayment(id, wrong, RESOURCE), (error: unknown) => error instanceof WorkflowError && error.httpStatus === 401);
    await assert.rejects(() => target.submitPayment(id, wrong, 'not-reached', RESOURCE), (error: unknown) => error instanceof WorkflowError && error.httpStatus === 401);
  }
  await assert.rejects(() => target.get(randomUUID(), token), (error: unknown) => error instanceof WorkflowError && error.httpStatus === 404);
  assert.equal((await target.get(id, token)).status, 'DRAFT');
});

test('drafting is idempotent by key and never produces a second draft', { timeout: 30_000 }, async () => {
  const target = service();
  const key = randomUUID();
  const first = await target.createDraft({ idempotencyKey: key, question: 'Will a retried Horizon draft request reuse its original draft?', requesterKind: 'agent', requester: 'agent:0.0.777' });
  created.push(first.request.id);
  const retry = await target.createDraft({ idempotencyKey: key, question: 'A completely different question that must be ignored on replay', requesterKind: 'agent', requester: 'agent:0.0.777' });
  assert.equal(retry.replay, true);
  assert.equal(retry.request.id, first.request.id);
  assert.equal(retry.request.question, first.request.question);
  assert.equal(retry.token, undefined);
  assert.equal(await db.creationRequest.count({ where: { idempotencyKey: key } }), 1);
});

test('the HTTP creation resource answers 402 once, then records one payment for both client kinds', { timeout: 60_000 }, async () => {
  const password = `test-${randomUUID()}`;
  const config: Config = {
    ...loadConfig({
      NODE_ENV: 'test', DATABASE_URL: url!, ADMIN_EMAIL: 'test@horizon.local',
      ADMIN_PASSWORD_HASH: await hashPassword(password), SESSION_SECRET: randomUUID() + randomUUID(),
      HEDERA_PAYMENT_MODE: 'simulated', HEDERA_RECEIVER_ACCOUNT_ID: '0.0.4242', AI_PROVIDER: 'development',
    }),
  };
  const built = await createApp(config, db);
  const server = built.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const configured = await (await fetch(`${base}/api/config`)).json() as { fees: { maker: number }; creation: { settlementMode: string }; world: { available: boolean }; ai: { mode: string } };
    assert.equal(configured.fees.maker, 0);
    assert.equal(configured.creation.settlementMode, 'simulated');
    assert.equal(configured.world.available, false);
    assert.equal(configured.ai.mode, 'development');

    for (const requesterKind of ['browser', 'agent'] as const) {
      const drafted = await fetch(`${base}/api/creation/requests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ question: `Will the Horizon ${requesterKind} client complete one paid creation request?`, requesterKind, requester: `client:${requesterKind}` }),
      });
      assert.equal(drafted.status, 201);
      const body = await drafted.json() as { request: { id: string; draftHash: string }; accessToken: string };
      created.push(body.request.id);
      const auth = { authorization: `Bearer ${body.accessToken}`, 'content-type': 'application/json' };
      const unauthorized = await fetch(`${base}/api/creation/requests/${body.request.id}`, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(unauthorized.status, 401);

      const approved = await fetch(`${base}/api/creation/requests/${body.request.id}/approval`, { method: 'POST', headers: auth, body: JSON.stringify({ draftHash: body.request.draftHash }) });
      assert.equal(approved.status, 200);
      const required = await fetch(`${base}/api/creation/requests/${body.request.id}/payment`, { method: 'POST', headers: auth, body: '{}' });
      assert.equal(required.status, 402);
      const requirements = await required.json() as { x402Version: number; resource: { url: string }; accepts: PaymentRequirements[] };
      assert.equal(requirements.x402Version, 2);
      assert.equal(requirements.accepts[0]!.scheme, 'exact');
      assert.equal(requirements.accepts[0]!.network, 'hedera:testnet');
      assert.equal(requirements.accepts[0]!.amount, '100000000');
      assert.equal(requirements.accepts[0]!.asset, '0.0.0');
      assert.equal(requirements.accepts[0]!.extra.feePayer, '0.0.0');
      assert.ok(required.headers.get('payment-required'));

      const authorization = payload(requirements.accepts[0]!, `0.0.${requesterKind === 'browser' ? 11 : 22}`);
      const paid = await fetch(`${base}/api/creation/requests/${body.request.id}/payment`, { method: 'POST', headers: { ...auth, 'payment-signature': authorization }, body: '{}' });
      assert.equal(paid.status, 200);
      assert.ok((paid.headers.get('payment-response') ?? '').length > 0);
      assert.ok((paid.headers.get('x-payment-response') ?? '').length > 0);
      const again = await fetch(`${base}/api/creation/requests/${body.request.id}/payment`, { method: 'POST', headers: { ...auth, 'payment-signature': payload(requirements.accepts[0]!, '0.0.999') }, body: '{}' });
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { replay: boolean }).replay, true);
      const intent = await db.paymentIntent.findUniqueOrThrow({ where: { requestId: body.request.id } });
      assert.equal(intent.status, 'SETTLED');
      assert.equal(intent.attempts, 1);
      assert.ok(intent.transactionRef!.startsWith('simulated:'));
    }

    // The admin API is closed until an operator authenticates, and its actions are audited.
    assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
    const login = await fetch(`${base}/api/admin/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'test@horizon.local', password: 'wrong-password' }) });
    assert.equal(login.status, 401);
    const good = await fetch(`${base}/api/admin/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'test@horizon.local', password }) });
    assert.equal(good.status, 200);
    const cookie = good.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ');
    const overview = await fetch(`${base}/api/admin/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const data = await overview.json() as { requests: { id: string }[]; resolverModel: { invalidPayout?: string; payouts: { INVALID: string } }; counts: Record<string, number> };
    assert.ok(data.requests.length > 0);
    assert.match(data.resolverModel.payouts.INVALID, /0\.5 USDC/);
    assert.ok((data.counts.PAID ?? 0) >= 2);
    // AdminJS remains inspection-only.
    assert.equal((await fetch(`${base}/admin/api/resources/PaymentIntent/actions/new`, { method: 'POST', headers: { cookie } })).status, 403);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await built.close();
  }
});
