import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transition, TRANSITIONS, WorkflowError, type Status } from '../src/creation/service.js';
import { creationPrice, formatUnits, utcDay } from '../src/creation/pricing.js';
import { findDuplicates, similarity } from '../src/creation/duplicates.js';
import { draftHash, draftSchema } from '../src/creation/types.js';
import { DevelopmentDraftProvider } from '../src/creation/ai.js';
import { decodePayment, buildRequirements, SimulatedFacilitator, PaymentPayloadError } from '../src/payments/x402.js';
import { createVerifier, UnavailableVerifier } from '../src/world/verifier.js';
import { summarize } from '../src/trading/liquidity.js';
import { marginalPrice } from '../src/trading/math.js';
import type { PaymentsConfig } from '../src/config.js';

const payments: PaymentsConfig = { facilitatorUrl: 'https://facilitator.invalid', network: 'hedera:testnet', payTo: '0.0.1234',
  asset: 'HBAR', assetDecimals: 8, mode: 'simulated', priceUnits: 100_000_000n, discountBps: 5000, timeoutSeconds: 300 };

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
  const requirements = buildRequirements(payments, { amountUnits: 50_000_000n, resource: 'https://horizon.local/api/creation/requests/x/payment', description: 'test', nonce: 'abc' });
  assert.equal(requirements.scheme, 'exact');
  assert.equal(requirements.maxAmountRequired, '50000000');
  assert.equal(requirements.extra.settlementMode, 'simulated');
  assert.throws(() => decodePayment('not-base64-json'), (error: unknown) => error instanceof PaymentPayloadError);
  assert.throws(() => decodePayment(Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'hedera:testnet', payload: {} })).toString('base64')),
    (error: unknown) => error instanceof PaymentPayloadError);
  const header = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'hedera:testnet', payload: { payer: '0.0.9' } })).toString('base64');
  const payload = decodePayment(header);
  const facilitator = new SimulatedFacilitator();
  assert.deepEqual(await facilitator.verify(payload, requirements), { valid: true, payer: '0.0.9' });
  const settled = await facilitator.settle(payload, requirements);
  // The simulated facilitator labels its own output; it never looks like a Hedera receipt.
  assert.ok(settled.transaction.startsWith('simulated:'));
  assert.equal(settled.mode, 'simulated');
  assert.deepEqual(await facilitator.verify({ ...payload, network: 'hedera:mainnet' }, requirements), { valid: false, reason: 'network_mismatch' });
});

test('World verification is unavailable until access is granted, and never grants a discount by default', async () => {
  const verifier = createVerifier({ appId: 'app_test', action: 'create-market', environment: 'staging', access: 'unknown', verifyUrl: 'https://developer.worldcoin.org' });
  assert.equal(verifier.available, false);
  assert.ok(verifier instanceof UnavailableVerifier);
  await assert.rejects(() => verifier.verify(), /verification_unavailable/);
  assert.equal(createVerifier({ appId: '', action: '', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.worldcoin.org' }).available, false);
  assert.equal(createVerifier({ appId: 'app_test', action: 'create-market', environment: 'staging', access: 'granted', verifyUrl: 'https://developer.worldcoin.org' }).available, true);
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
