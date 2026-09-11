import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_SCHEMA, AuditMessageError, auditEventId, auditMessageSchema, auditSequence,
  draftApproved, encodeAuditMessage, marketCreated, MAX_MESSAGE_BYTES, paymentSettled,
} from '../src/audit/events.js';
import { consensusDate, explorerTransactionId, parseAuditKey } from '../src/audit/hcs.js';

const REQUEST = '3f9c2a6e-1d4b-4c8f-9a2e-77b1c0d5e6f0';
const DRAFT_HASH = 'a'.repeat(64);
const PAYMENT_REF = '0.0.7162784@1788954987.856633335';
const MARKET = '0xBC11a878771E75a1C32bfB23A0B40db704F27432';
const CREATION_TX = `0x${'ab'.repeat(32)}`;
const AT = new Date('2026-09-11T10:00:00.000Z');

const approved = () => draftApproved({ requestId: REQUEST, draftHash: DRAFT_HASH, occurredAt: AT });
const settled = () => paymentSettled({
  requestId: REQUEST, draftHash: DRAFT_HASH, occurredAt: AT,
  network: 'hedera:testnet', asset: '0.0.0', amountUnits: '100000000', transactionRef: PAYMENT_REF,
});
const created = (position?: number) => marketCreated({
  requestId: REQUEST, draftHash: DRAFT_HASH, occurredAt: AT, transactionRef: PAYMENT_REF,
  chainId: 11155111, address: MARKET, transactionHash: CREATION_TX, position,
});

test('an event id is stable, derived from the request and type, and distinct per event', () => {
  assert.equal(auditEventId(REQUEST, 'DRAFT_APPROVED'), auditEventId(REQUEST, 'DRAFT_APPROVED'));
  assert.match(auditEventId(REQUEST, 'DRAFT_APPROVED'), /^[a-f0-9]{64}$/);
  const ids = new Set([
    auditEventId(REQUEST, 'DRAFT_APPROVED'), auditEventId(REQUEST, 'PAYMENT_SETTLED'),
    auditEventId(REQUEST, 'MARKET_CREATED'), auditEventId(REQUEST, 'MARKET_CREATED', 0),
    auditEventId(REQUEST, 'MARKET_CREATED', 1),
    auditEventId('4f9c2a6e-1d4b-4c8f-9a2e-77b1c0d5e6f0', 'DRAFT_APPROVED'),
  ]);
  assert.equal(ids.size, 6, 'every type, position and request must derive a different id');
  // A statement carries its own id, so a reader can deduplicate from the message alone.
  assert.equal(approved().message.eventId, auditEventId(REQUEST, 'DRAFT_APPROVED'));
});

test('publication order within a request is derived, not counted', () => {
  assert.equal(auditSequence('DRAFT_APPROVED'), 1);
  assert.equal(auditSequence('PAYMENT_SETTLED'), 2);
  assert.equal(auditSequence('MARKET_CREATED'), 3);
  // A group's children keep the order of their positions, after the payment that bought them.
  assert.deepEqual([0, 1, 2].map(position => auditSequence('MARKET_CREATED', position)), [3, 4, 5]);
  assert.ok(auditSequence('MARKET_CREATED', 0) > auditSequence('PAYMENT_SETTLED'));
  assert.ok(auditSequence('PAYMENT_SETTLED') > auditSequence('DRAFT_APPROVED'));
});

test('every statement carries its version, the request and the approved draft hash', () => {
  for (const record of [approved(), settled(), created(), created(2)]) {
    assert.equal(record.message.schema, AUDIT_SCHEMA);
    assert.equal(record.message.requestId, REQUEST);
    assert.equal(record.message.draftHash, DRAFT_HASH);
    assert.equal(record.message.occurredAt, AT.toISOString());
    assert.equal(record.backfilled, false);
  }
  const payment = settled().message;
  assert.equal(payment.type, 'PAYMENT_SETTLED');
  if (payment.type !== 'PAYMENT_SETTLED') throw new Error('unreachable');
  assert.deepEqual(payment.payment, {
    network: 'hedera:testnet', asset: '0.0.0', amountUnits: '100000000', transactionRef: PAYMENT_REF,
  });
  const market = created(2).message;
  assert.equal(market.type, 'MARKET_CREATED');
  if (market.type !== 'MARKET_CREATED') throw new Error('unreachable');
  assert.deepEqual(market.market, { chainId: 11155111, address: MARKET, transactionHash: CREATION_TX, position: 2 });
  assert.equal(market.payment.transactionRef, PAYMENT_REF);
});

test('encoding is canonical, so a republished statement is byte-identical', () => {
  const message = created().message;
  const encoded = encodeAuditMessage(message);
  // A payload read back from jsonb has been reordered by PostgreSQL; re-encoding must not care.
  const reordered = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const shuffled = Object.fromEntries(Object.entries(reordered).reverse());
  assert.equal(encodeAuditMessage(shuffled), encoded);
  assert.equal(encodeAuditMessage(JSON.parse(encoded)), encoded);
  assert.equal(JSON.parse(encoded).schema, AUDIT_SCHEMA);
});

test('a statement fits one HCS message', () => {
  for (const record of [approved(), settled(), created(), created(63)]) {
    const size = Buffer.byteLength(encodeAuditMessage(record.message), 'utf8');
    assert.ok(size <= MAX_MESSAGE_BYTES, `${record.type} is ${size} bytes`);
  }
});

test('the schema is closed: nothing outside it can be published', () => {
  const message = JSON.parse(encodeAuditMessage(approved().message)) as Record<string, unknown>;
  // Secrets, credentials and personal data are refused structurally, not filtered out.
  for (const extra of ['accessToken', 'privateKey', 'nullifierHash', 'requester', 'payer', 'question']) {
    assert.throws(() => encodeAuditMessage({ ...message, [extra]: 'leaked' }), AuditMessageError, `${extra} must be refused`);
  }
  assert.throws(() => encodeAuditMessage({ ...message, schema: 'horizon.audit.v2' }), AuditMessageError);
  assert.throws(() => encodeAuditMessage({ ...message, draftHash: 'not-a-hash' }), AuditMessageError);
  assert.throws(() => encodeAuditMessage({ ...message, requestId: 'not-a-uuid' }), AuditMessageError);
  const market = JSON.parse(encodeAuditMessage(created().message)) as { market: Record<string, unknown> };
  assert.throws(() => encodeAuditMessage({ ...market, market: { ...market.market, address: 'nope' } }), AuditMessageError);
});

test('no statement carries a secret, a token, a proof or a person', () => {
  // Everything a request holds that must never be published, in the shapes it holds them.
  const forbidden = [
    'f'.repeat(64),                                        // an access-token hash
    '0x' + 'de'.repeat(32),                                // a deployer or audit private key
    '0x1111111111111111111111111111111111111111',          // a requester wallet
    'nullifier-0xabc',                                     // a World credential identifier
    'proof_0x1234', 'selfie', 'admin@horizon.local', '0.0.99',
  ];
  const encoded = [approved(), settled(), created(), created(1)].map(record => encodeAuditMessage(record.message)).join('\n');
  for (const secret of forbidden) assert.ok(!encoded.includes(secret), `${secret} must not appear in a statement`);
  // Only the declared keys ever appear.
  const keys = new Set([...encoded.matchAll(/"([a-zA-Z]+)":/g)].map(match => match[1]));
  assert.deepEqual([...keys].sort(), [
    'address', 'amountUnits', 'asset', 'chainId', 'draftHash', 'eventId', 'market', 'network',
    'occurredAt', 'payment', 'position', 'requestId', 'schema', 'transactionHash', 'transactionRef', 'type',
  ]);
});

test('a backfilled statement says so, and keeps the event time it actually had', () => {
  const record = draftApproved({ requestId: REQUEST, draftHash: DRAFT_HASH, occurredAt: AT, backfilled: true });
  assert.equal(record.backfilled, true);
  assert.equal(record.message.backfilled, true);
  // The event time travels in the statement; the consensus timestamp is assigned at publication
  // and is never written here, so it cannot be mistaken for the time of the event.
  assert.equal(record.message.occurredAt, AT.toISOString());
  assert.ok(!('consensusAt' in record.message));
  // A statement written by the workflow itself carries no such flag at all.
  assert.ok(!('backfilled' in JSON.parse(encodeAuditMessage(approved().message))));
  // The id and the order do not change: a backfilled statement is the same statement.
  assert.equal(record.eventId, approved().eventId);
  assert.equal(record.sequence, approved().sequence);
});

test('a market statement admits an unobserved deployment transaction rather than inventing one', () => {
  const record = marketCreated({
    requestId: REQUEST, draftHash: DRAFT_HASH, occurredAt: AT, transactionRef: PAYMENT_REF,
    chainId: 11155111, address: MARKET, transactionHash: null,
  });
  const message = auditMessageSchema.parse(JSON.parse(encodeAuditMessage(record.message)));
  assert.equal(message.type, 'MARKET_CREATED');
  if (message.type !== 'MARKET_CREATED') throw new Error('unreachable');
  assert.equal(message.market.transactionHash, null);
  assert.equal(message.market.address, MARKET);
});

test('mirror-node helpers read Hedera timestamps and explorer ids', () => {
  assert.equal(consensusDate('1788954987.856633335').toISOString(), new Date(1788954987856).toISOString());
  assert.equal(explorerTransactionId('0.0.7162784@1788954987.856633335'), '0.0.7162784-1788954987-856633335');
});

test('an audit signer key is parsed by its declared type, and a DER encoding names its own', () => {
  const ecdsa = parseAuditKey('7f'.repeat(32), 'ecdsa');
  const ed25519 = parseAuditKey('7f'.repeat(32), 'ed25519');
  assert.notEqual(ecdsa.publicKey.toStringDer(), ed25519.publicKey.toStringDer());
  // A 0x prefix is accepted, and a DER string is detected whatever the declared type says.
  assert.equal(parseAuditKey(`0x${'7f'.repeat(32)}`, 'ecdsa').publicKey.toStringDer(), ecdsa.publicKey.toStringDer());
  assert.equal(parseAuditKey(ed25519.toStringDer(), 'ecdsa').publicKey.toStringDer(), ed25519.publicKey.toStringDer());
});
