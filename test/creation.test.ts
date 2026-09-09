import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition, TRANSITIONS, WorkflowError, type Status } from '../src/creation/service.js';
import { creationPrice, formatUnits, utcDay } from '../src/creation/pricing.js';
import { findDuplicates, similarity } from '../src/creation/duplicates.js';
import { draftHash, draftSchema } from '../src/creation/types.js';
import { DevelopmentDraftProvider } from '../src/creation/ai.js';
import { decodePayment, buildRequirements, paymentMatches, SimulatedFacilitator, PaymentPayloadError } from '../src/payments/x402.js';
import { createRpContext, createVerifier, proofSchema, UnavailableVerifier, VerificationRejectedError, VerificationUnavailableError, WorldSelfieVerifier } from '../src/world/verifier.js';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { buildBook, summarize } from '../src/trading/liquidity.js';
import { marginalPrice } from '../src/trading/math.js';
import type { PaymentsConfig } from '../src/config.js';

const payments: PaymentsConfig = { facilitatorUrl: 'https://facilitator.invalid', network: 'hedera:testnet', payTo: '0.0.1234',
  asset: '0.0.0', assetDecimals: 8, mode: 'simulated', priceUnits: 100_000_000n, discountBps: 5000, timeoutSeconds: 300 };

test('creation workflow only advances along declared transitions', () => {
  assert.equal(transition('DRAFT', 'approve'), 'APPROVED');
  assert.equal(transition('APPROVED', 'require_payment'), 'PAYMENT_REQUIRED');
  assert.equal(transition('PAYMENT_REQUIRED', 'settle'), 'PAID');
  assert.equal(transition('PAYMENT_REQUIRED', 'review'), 'PAYMENT_REVIEW');
  assert.equal(transition('PAYMENT_REVIEW', 'settle'), 'PAID');
  assert.equal(transition('PAID', 'start_creation'), 'CREATING');
  assert.equal(transition('CREATING', 'created'), 'CREATED');
  assert.equal(transition('CREATING', 'fail'), 'FAILED');
  assert.equal(transition('FAILED', 'retry'), 'CREATING');
  // Skipping review, approval or payment is impossible, and a created market is terminal.
  for (const [status, event] of [['DRAFT', 'require_payment'], ['DRAFT', 'settle'], ['APPROVED', 'settle'],
    ['PAYMENT_REQUIRED', 'start_creation'], ['CREATED', 'retry'], ['CREATED', 'approve']] as [Status, Parameters<typeof transition>[1]][]) {
    assert.throws(() => transition(status, event), (error: unknown) => error instanceof WorkflowError);
  }
  assert.deepEqual(TRANSITIONS.CREATED, {});
});

test('creation price applies the discount only to a verified request and rounds it down', () => {
  assert.deepEqual(creationPrice(100_000_000n, 5000, false), { baseUnits: 100_000_000n, discountBps: 0, discountUnits: 0n, payableUnits: 100_000_000n });
  assert.deepEqual(creationPrice(100_000_000n, 5000, true), { baseUnits: 100_000_000n, discountBps: 5000, discountUnits: 50_000_000n, payableUnits: 50_000_000n });
  // Rounding down the discount keeps the payable amount at or above the intended net price.
  assert.equal(creationPrice(3n, 5000, true).payableUnits, 2n);
  assert.equal(creationPrice(100n, 0, true).payableUnits, 100n);
  assert.equal(creationPrice(100n, 10_000, true).payableUnits, 0n);
  assert.throws(() => creationPrice(0n, 5000, true), /invalid_base_price/);
  assert.throws(() => creationPrice(100n, 10_001, true), /invalid_discount_bps/);
  assert.throws(() => creationPrice(100n, 1.5, true), /invalid_discount_bps/);
  assert.equal(formatUnits(50_000_000n, 8), '0.5');
  assert.equal(formatUnits(100_000_000n, 8), '1');
  assert.equal(utcDay(new Date('2026-09-09T23:59:59Z')), '2026-09-09');
});

test('duplicate detection cites real indexed markets and ignores unrelated questions', () => {
  const markets = [
    { id: '0x1111111111111111111111111111111111111111', question: 'Will Ethereum Sepolia process more than one million transactions in September 2026?', closeAt: '2026-10-01T00:00:00.000Z', result: 0 },
    { id: '0x2222222222222222222222222222222222222222', question: 'Will the local bakery open a second branch this year?', closeAt: '2026-12-01T00:00:00.000Z', result: 0 },
  ];
  const warnings = findDuplicates('Will Ethereum Sepolia process more than one million transactions in September 2026?', markets);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.market, markets[0]!.id);
  assert.ok(warnings[0]!.similarity >= 0.6);
  assert.equal(findDuplicates('Will it rain in Lisbon on Friday?', markets).length, 0);
  assert.ok(similarity('a b c', '') === 0);
});

test('approval binds to the exact reviewed draft', () => {
  const draft = draftSchema.parse({
    question: 'Will Horizon publish a Phase 3 demo before October 2026?', yesOutcome: 'YES', noOutcome: 'NO',
    category: 'Technology', closeAt: '2026-10-01T00:00:00.000Z',
    rules: 'YES if the public repository contains a recorded Phase 3 demo before the close time; NO otherwise; INVALID if undecidable.',
    evidenceSource: 'Public repository and recorded demo link.',
  });
  const hash = draftHash(draft);
  assert.equal(hash, draftHash({ ...draft }));
  assert.notEqual(hash, draftHash({ ...draft, rules: `${draft.rules} Extra clause.` }));
  assert.notEqual(hash, draftHash({ ...draft, closeAt: '2026-11-01T00:00:00.000Z' }));
});

test('the development draft provider produces a reviewable draft grounded on indexed markets', async () => {
  const provider = new DevelopmentDraftProvider(() => new Date('2026-09-09T12:00:00Z'));
  const result = await provider.draft({ question: 'will bitcoin close above one hundred thousand dollars in 2026', requesterKind: 'browser' },
    { indexedBlock: 42, markets: [{ id: '0x3333333333333333333333333333333333333333', question: 'Will bitcoin close above one hundred thousand dollars in 2026?', closeAt: '2026-12-31T00:00:00.000Z', result: 0 }] });
  assert.equal(result.mode, 'development');
  assert.equal(result.draft.question, 'Will bitcoin close above one hundred thousand dollars in 2026?');
  assert.equal(result.draft.category, 'Crypto');
  assert.ok(result.draft.rules.includes('INVALID'));
  assert.equal(result.groundedOnBlock, 42);
  assert.equal(result.duplicates.length, 1);
  assert.ok(new Date(result.draft.closeAt).getTime() > Date.parse('2026-09-09T12:00:00Z'));
  draftSchema.parse(result.draft);
});

test('x402 requirements and payloads are validated before any settlement attempt', async () => {
  const requirements = await new SimulatedFacilitator().prepare(buildRequirements(payments, { amountUnits: 50_000_000n, nonce: 'abc' }));
  assert.equal(requirements.scheme, 'exact');
  assert.equal(requirements.amount, '50000000');
  assert.equal(requirements.asset, '0.0.0');
  assert.equal(requirements.extra.feePayer, '0.0.0');
  assert.equal(requirements.extra.settlementMode, 'simulated');
  assert.throws(() => decodePayment('not-base64-json'), (error: unknown) => error instanceof PaymentPayloadError);
  assert.throws(() => decodePayment(Buffer.from(JSON.stringify({ x402Version: 1, accepted: requirements, payload: {} })).toString('base64')),
    (error: unknown) => error instanceof PaymentPayloadError);
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: requirements, payload: { payer: '0.0.9' } })).toString('base64');
  const payload = decodePayment(header);
  const facilitator = new SimulatedFacilitator();
  assert.deepEqual(await facilitator.verify(payload, requirements), { valid: true, payer: '0.0.9' });
  const settled = await facilitator.settle(payload, requirements);
  // The simulated facilitator labels its own output; it never looks like a Hedera receipt.
  assert.ok(settled.transaction.startsWith('simulated:'));
  assert.equal(settled.mode, 'simulated');
  assert.deepEqual(await facilitator.verify({ ...payload, accepted: { ...payload.accepted, network: 'hedera:mainnet' } }, requirements), { valid: false, reason: 'network_mismatch' });
});

test('World verification is unavailable until access is granted, and never grants a discount by default', async () => {
  const verifier = createVerifier({ appId: 'app_test', rpId: 'rp_test', action: 'create-market', environment: 'staging', access: 'unknown', verifyUrl: 'https://developer.world.org' });
  assert.equal(verifier.available, false);
  assert.ok(verifier instanceof UnavailableVerifier);
  await assert.rejects(() => verifier.verify(), /verification_unavailable/);
  assert.equal(createVerifier({ appId: '', rpId: '', action: '', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.world.org' }).available, false);
  assert.equal(createVerifier({ appId: 'app_test', rpId: 'rp_test', action: 'create-market', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.world.org' }).available, true);
  const rp = createRpContext({ appId: 'app_test', rpId: 'rp_test', signingKey: `0x${'11'.repeat(32)}`, action: 'create-market', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.world.org' });
  assert.equal(rp.rp_id, 'rp_test');
  assert.match(rp.signature, /^0x[0-9a-f]+$/i);
  assert.ok(rp.expires_at > rp.created_at);
  proofSchema.parse({
    protocol_version: '3.0', nonce: 'request-nonce', action: 'create-market', environment: 'staging', user_presence_completed: true,
    responses: [{ identifier: 'selfie', signal_hash: `0x${'12'.repeat(32)}`, proof: `0x${'34'.repeat(64)}`,
      merkle_root: `0x${'56'.repeat(32)}`, nullifier: `0x${'78'.repeat(32)}` }],
  });
});

test('a payment authorization must match the exact requirements that were issued', async () => {
  const requirements = await new SimulatedFacilitator().prepare(buildRequirements(payments, { amountUnits: 50_000_000n, nonce: 'issued-nonce' }));
  const payload = { x402Version: 2 as const, accepted: requirements, payload: { payer: '0.0.9' } };
  assert.equal(paymentMatches(payload, requirements), true);
  // Every field a payer could rewrite to underpay, redirect or replay must break the binding.
  const tampered: Partial<typeof requirements>[] = [
    { amount: '1' }, { payTo: '0.0.9999' }, { asset: '0.0.1234' }, { network: 'hedera:mainnet' },
    { maxTimeoutSeconds: 1 }, { scheme: 'exact2' as 'exact' },
  ];
  for (const change of tampered) {
    assert.equal(paymentMatches({ ...payload, accepted: { ...requirements, ...change } }, requirements), false, JSON.stringify(change));
  }
  for (const extra of [{ nonce: 'other-nonce' }, { feePayer: '0.0.4242' }]) {
    assert.equal(paymentMatches({ ...payload, accepted: { ...requirements, extra: { ...requirements.extra, ...extra } } }, requirements), false, JSON.stringify(extra));
  }
});

test('a World proof is refused unless it is bound to this action, environment and request', async () => {
  // An unreachable endpoint keeps this offline: reaching it proves the binding checks passed.
  const config = { appId: 'app_test', rpId: 'rp_test', signingKey: `0x${'11'.repeat(32)}`, action: 'create-market',
    environment: 'staging' as const, access: 'granted' as const, verifyUrl: 'http://127.0.0.1:1' };
  const verifier = new WorldSelfieVerifier(config);
  const requestId = '11111111-2222-3333-4444-555555555555';
  const proof = (overrides: Record<string, unknown> = {}, signal = requestId) => proofSchema.parse({
    protocol_version: '3.0', nonce: 'request-nonce', action: config.action, environment: config.environment,
    user_presence_completed: true,
    responses: [{ identifier: 'selfie', signal_hash: hashSignal(signal).toLowerCase(), proof: `0x${'34'.repeat(64)}`,
      merkle_root: `0x${'56'.repeat(32)}`, nullifier: `0x${'78'.repeat(32)}` }],
    ...overrides,
  });
  await assert.rejects(() => verifier.verify(proof({ action: 'another-action' }), requestId),
    (error: unknown) => error instanceof VerificationRejectedError);
  await assert.rejects(() => verifier.verify(proof({ environment: 'production' }), requestId),
    (error: unknown) => error instanceof VerificationRejectedError);
  // A credential proved for a different creation request cannot be replayed onto this one.
  await assert.rejects(() => verifier.verify(proof({}, 'another-request'), requestId),
    (error: unknown) => error instanceof VerificationRejectedError);
  await assert.rejects(() => verifier.verify(proof(), requestId),
    (error: unknown) => error instanceof VerificationUnavailableError);
});

test('one outcome\'s book restates the other outcome\'s orders at one minus their price', () => {
  const market = '0x4444444444444444444444444444444444444444' as const;
  const salt = `0x${'11'.repeat(32)}` as const;
  const flat = (isYes: boolean, isBuy: boolean, price: number, size: bigint, filled = 0n, id = `0x${'ab'.repeat(32)}` as const) => ({
    id, maker: market, filled,
    strategy: { market, flags: 4 + (isBuy ? 2 : 0) + (isYes ? 1 : 0), startPrice: price, endPrice: price, maxShares: size, salt },
  });
  const book = buildBook([
    flat(true, false, 620_000, 3_000_000n, 0n, `0x${'01'.repeat(32)}`),  // SELL YES 0.62
    flat(true, true, 550_000, 2_000_000n, 0n, `0x${'02'.repeat(32)}`),   // BUY YES 0.55
    flat(false, true, 380_000, 4_000_000n, 0n, `0x${'03'.repeat(32)}`),  // BUY NO 0.38 -> YES ask 0.62
    flat(false, false, 300_000, 5_000_000n, 0n, `0x${'04'.repeat(32)}`), // SELL NO 0.30 -> YES bid 0.70
    flat(true, false, 900_000, 1_000_000n, 1_000_000n, `0x${'05'.repeat(32)}`), // exhausted, excluded
  ]);

  // A resting BUY NO is an executable YES ask at 1 - price, and merges into the same level as
  // a direct SELL YES quoting that price.
  assert.deepEqual(book.yes.asks.map(level => [level.price, level.shares.toString(), level.orders, level.source, level.executable]), [
    [620_000, '7000000', 2, 'mixed', true],
  ]);
  // A resting SELL NO restates as a YES bid, but filling it needs sell-and-merge routing.
  assert.deepEqual(book.yes.bids.map(level => [level.price, level.shares.toString(), level.source, level.executable]), [
    [700_000, '5000000', 'complementary', false],
    [550_000, '2000000', 'direct', true],
  ]);
  // The spread ignores depth that cannot be filled today.
  assert.equal(book.yes.spread, 620_000 - 550_000);

  // The NO book is the exact mirror.
  assert.deepEqual(book.no.asks.map(level => [level.price, level.source, level.executable]), [
    [300_000, 'direct', true],
    [450_000, 'complementary', true],
  ]);
  assert.deepEqual(book.no.bids.map(level => [level.price, level.source, level.executable]), [
    [380_000, 'direct', true],
    [380_000, 'complementary', false],
  ]);
  assert.equal(book.no.spread, 300_000 - 380_000);
});

test('indexed liquidity treats complementary buy curves as available depth for the other outcome', () => {
  const market = '0x4444444444444444444444444444444444444444' as const;
  const salt = `0x${'11'.repeat(32)}` as const;
  // A resting NO buyer at 0.40 makes YES available at 0.60 through complementary minting.
  const noBuy = { id: `0x${'aa'.repeat(32)}` as const, maker: market, filled: 0n,
    strategy: { market, flags: 1 * 4 + 2, startPrice: 400_000, endPrice: 400_000, maxShares: 2_000_000n, salt } };
  const yesSell = { id: `0x${'bb'.repeat(32)}` as const, maker: market, filled: 500_000n,
    strategy: { market, flags: 1 * 4 + 1, startPrice: 500_000, endPrice: 700_000, maxShares: 1_000_000n, salt } };
  const summary = summarize([noBuy, yesSell]);
  assert.equal(summary.no.bid, 400_000);
  assert.equal(summary.yes.ask, 600_000);
  assert.equal(summary.yes.availableShares, 2_500_000n);
  assert.equal(summary.curves, 2);
  assert.equal(marginalPrice(yesSell.strategy, 500_000n), 600_000);
  assert.equal(marginalPrice(yesSell.strategy, 1_000_000n), 700_000);
});
