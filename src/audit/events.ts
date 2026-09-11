import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The versioned public audit statement.
 *
 * Three facts about one creation request are published: the exact draft a human approved, the
 * Hedera x402 payment that settled for it, and the Sepolia market that was deployed. Together
 * they are a timestamped chain from an approved question to a live market, and every reference
 * in them points at something a third party can check at its own source.
 *
 * The schema is closed. `auditMessageSchema` is strict, every message is validated against it
 * immediately before submission, and the payload is rebuilt from an explicit field list rather
 * than spread from a database row — so a private key, an access token, a World proof, a
 * credential identifier or any other personal field cannot reach the topic by accident.
 */
export const AUDIT_SCHEMA = 'horizon.audit.v1';
export const AUDIT_TYPES = ['DRAFT_APPROVED', 'PAYMENT_SETTLED', 'MARKET_CREATED'] as const;
export type AuditType = typeof AUDIT_TYPES[number];

/** A single HCS message is 1024 bytes. Every field below is bounded so no statement can chunk. */
export const MAX_MESSAGE_BYTES = 1024;

export class AuditMessageError extends Error {}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const iso = z.string().datetime();
const hederaTransactionRef = z.string().min(1).max(128);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const evmTxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const head = {
  schema: z.literal(AUDIT_SCHEMA),
  eventId: sha256Hex,
  requestId: uuid,
  /** When the fact happened, as the service observed it. Never the consensus timestamp. */
  occurredAt: iso,
  /** The canonical draft hash the request was approved against; unchanged from the existing one. */
  draftHash: sha256Hex,
  /**
   * Present and `true` only on a statement written after the fact. Its consensus timestamp is the
   * time of publication, so a reader must never treat it as the time of the event.
   */
  backfilled: z.literal(true).optional(),
};

export const auditMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...head, type: z.literal('DRAFT_APPROVED') }).strict(),
  z.object({
    ...head, type: z.literal('PAYMENT_SETTLED'),
    payment: z.object({
      network: z.string().min(1).max(64), asset: z.string().min(1).max(128),
      amountUnits: z.string().regex(/^\d{1,32}$/), transactionRef: hederaTransactionRef,
    }).strict(),
  }).strict(),
  z.object({
    ...head, type: z.literal('MARKET_CREATED'),
    payment: z.object({ transactionRef: hederaTransactionRef }).strict(),
    market: z.object({
      chainId: z.number().int().positive(),
      address: evmAddress,
      /**
       * The confirmed deployment transaction. Null only when this service resumed a run and found
       * the market already recorded in the registry without having observed its broadcast; the
       * address and the creation id remain checkable on chain either way.
       */
      transactionHash: evmTxHash.nullable(),
      /** The child's position inside an event. Absent for a standalone market. */
      position: z.number().int().min(0).max(63).optional(),
    }).strict(),
  }).strict(),
]);
export type AuditMessage = z.infer<typeof auditMessageSchema>;

/**
 * A stable identifier for one statement, derived from the durable request id and the event type —
 * and, for a child of an event, its position, exactly as `creationId` derives an on-chain
 * creation id. Two attempts at the same statement always produce the same id, which is what makes
 * the outbox write idempotent and what lets a reader deduplicate a resubmitted message.
 */
export function auditEventId(requestId: string, type: AuditType, position?: number): string {
  const key = position === undefined ? `${AUDIT_SCHEMA}:${requestId}:${type}` : `${AUDIT_SCHEMA}:${requestId}:${type}:${position}`;
  return createHash('sha256').update(key).digest('hex');
}

const ORDINAL: Record<AuditType, number> = { DRAFT_APPROVED: 1, PAYMENT_SETTLED: 2, MARKET_CREATED: 3 };

/**
 * Publication order within one request. Derived, never counted: counting rows would let two
 * concurrent writers claim different places in the order, and would make a retried write a new
 * event rather than the same one.
 */
export function auditSequence(type: AuditType, position?: number): number {
  return ORDINAL[type] + (type === 'MARKET_CREATED' ? (position ?? 0) : 0);
}

export type AuditRecord = {
  eventId: string; requestId: string; type: AuditType; sequence: number;
  occurredAt: Date; backfilled: boolean; message: AuditMessage;
};

type Common = { requestId: string; draftHash: string; occurredAt: Date; backfilled?: boolean };

const common = (input: Common, type: AuditType, position?: number) => ({
  schema: AUDIT_SCHEMA,
  eventId: auditEventId(input.requestId, type, position),
  requestId: input.requestId,
  occurredAt: input.occurredAt.toISOString(),
  draftHash: input.draftHash,
  ...(input.backfilled ? { backfilled: true } : {}),
});

const record = (input: Common, type: AuditType, message: AuditMessage, position?: number): AuditRecord => ({
  eventId: message.eventId, requestId: input.requestId, type, sequence: auditSequence(type, position),
  occurredAt: input.occurredAt, backfilled: Boolean(input.backfilled), message,
});

/** A human approved this exact draft. Nothing has been charged and nothing deployed yet. */
export function draftApproved(input: Common): AuditRecord {
  const message = auditMessageSchema.parse({ ...common(input, 'DRAFT_APPROVED'), type: 'DRAFT_APPROVED' });
  return record(input, 'DRAFT_APPROVED', message);
}

/** The x402 charge for that draft settled. Written only once the settlement receipt is stored. */
export function paymentSettled(input: Common & {
  network: string; asset: string; amountUnits: string; transactionRef: string;
}): AuditRecord {
  const message = auditMessageSchema.parse({
    ...common(input, 'PAYMENT_SETTLED'), type: 'PAYMENT_SETTLED',
    payment: { network: input.network, asset: input.asset, amountUnits: input.amountUnits, transactionRef: input.transactionRef },
  });
  return record(input, 'PAYMENT_SETTLED', message);
}

/** The market exists on chain. Written only after the deployment receipt is confirmed. */
export function marketCreated(input: Common & {
  transactionRef: string; chainId: number; address: string; transactionHash: string | null; position?: number;
}): AuditRecord {
  const message = auditMessageSchema.parse({
    ...common(input, 'MARKET_CREATED', input.position), type: 'MARKET_CREATED',
    payment: { transactionRef: input.transactionRef },
    market: {
      chainId: input.chainId, address: input.address, transactionHash: input.transactionHash,
      ...(input.position === undefined ? {} : { position: input.position }),
    },
  });
  return record(input, 'MARKET_CREATED', message, input.position);
}

/**
 * The exact bytes submitted to the topic.
 *
 * Key order is fixed here rather than inherited from the stored object, because a payload read
 * back from `jsonb` has been normalised by PostgreSQL. Re-encoding canonically makes the message
 * a function of its fields alone, so a republished statement is byte-identical to the first one
 * and a mirror-node readback can be compared exactly.
 */
export function encodeAuditMessage(input: unknown): string {
  const parsed = auditMessageSchema.safeParse(input);
  if (!parsed.success) throw new AuditMessageError('audit_message_invalid');
  const message = parsed.data;
  const ordered: Record<string, unknown> = {
    schema: message.schema, type: message.type, eventId: message.eventId,
    requestId: message.requestId, occurredAt: message.occurredAt, draftHash: message.draftHash,
  };
  if (message.backfilled) ordered.backfilled = true;
  if (message.type === 'PAYMENT_SETTLED') {
    ordered.payment = {
      network: message.payment.network, asset: message.payment.asset,
      amountUnits: message.payment.amountUnits, transactionRef: message.payment.transactionRef,
    };
  }
  if (message.type === 'MARKET_CREATED') {
    ordered.payment = { transactionRef: message.payment.transactionRef };
    ordered.market = {
      chainId: message.market.chainId, address: message.market.address,
      transactionHash: message.market.transactionHash,
      ...(message.market.position === undefined ? {} : { position: message.market.position }),
    };
  }
  const encoded = JSON.stringify(ordered);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) throw new AuditMessageError('audit_message_too_large');
  return encoded;
}

/** What this trail does and does not attest. Stated wherever the trail is shown. */
export const AUDIT_DISCLOSURE =
  'Hedera Consensus Service records Horizon\'s own statements about this request and the order in which it made them. '
  + 'It does not independently verify the Hedera payment, the Sepolia deployment, or the eventual outcome of a market — '
  + 'each of those is checked at its own source, and the references published here are what let you check them.';

/** Delivery is at least once, and it is never described otherwise. */
export const AUDIT_DELIVERY_NOTE =
  'A submission whose outcome was unknown is reconciled against the mirror node and resubmitted only if it cannot be found, '
  + 'so one statement can appear on the topic more than once. Readers deduplicate by eventId.';
