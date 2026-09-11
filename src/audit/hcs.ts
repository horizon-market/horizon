import { z } from 'zod';
import {
  Client, PrecheckStatusError, PrivateKey, ReceiptStatusError, TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk';
import type { AuditConfig } from '../config.js';
import { MAX_MESSAGE_BYTES } from './events.js';

export type PublishResult = { transactionId: string; consensusAt: Date; sequenceNumber: string };

/** The network refused the submission before consensus, and will refuse it again unchanged. */
export class AuditPublishRejectedError extends Error {
  constructor(readonly reason: string) { super('audit_publish_rejected'); }
}
/** Transient: nothing reached consensus, and the same message can be sent again unchanged. */
export class AuditPublishUnavailableError extends Error {
  constructor(readonly reason: string) { super('audit_publish_unavailable'); }
}
/**
 * The outcome is unknown. The message may or may not be on the topic, so it is never simply
 * retried: it is reconciled against the mirror node first.
 */
export class AuditPublishAmbiguousError extends Error {
  constructor(readonly reason: string, readonly transactionId?: string) { super('audit_publish_ambiguous'); }
}

export interface AuditPublisher {
  readonly available: boolean;
  readonly network: string;
  readonly topicId: string;
  publish(message: string): Promise<PublishResult>;
  close(): void;
}

/**
 * A submission that reached consensus and failed there is definitive, so these statuses are the
 * ones worth separating from "try again later": nothing about the message will make them pass.
 */
const PERMANENT = new Set([
  'INVALID_TOPIC_ID', 'TOPIC_DELETED', 'TOPIC_EXPIRED', 'UNAUTHORIZED', 'INVALID_SIGNATURE',
  'INVALID_SUBMIT_KEY', 'MESSAGE_SIZE_TOO_LARGE', 'INVALID_CHUNK_NUMBER', 'INVALID_CHUNK_TRANSACTION_ID',
  'INVALID_ACCOUNT_ID', 'PAYER_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETED', 'AUTORENEW_ACCOUNT_NOT_ALLOWED',
]);

const statusOf = (error: unknown) =>
  error instanceof PrecheckStatusError || error instanceof ReceiptStatusError ? error.status.toString() : undefined;

/**
 * Hedera keys come in three shapes on the developer portal. A DER encoding names its own curve,
 * so it is detected; a bare 32-byte hex string does not, and the operator declares it.
 */
export function parseAuditKey(raw: string, keyType: AuditConfig['keyType']): PrivateKey {
  const value = raw.trim().replace(/^0x/, '');
  if (keyType === 'der' || (value.length > 64 && value.startsWith('30'))) return PrivateKey.fromStringDer(value);
  return keyType === 'ed25519' ? PrivateKey.fromStringED25519(value) : PrivateKey.fromStringECDSA(value);
}

/**
 * Submits one statement per call to the configured topic.
 *
 * The topic's submit key is the audit signer's, so only this service can append to it. Nothing
 * here reports a publication without a consensus timestamp and a topic sequence number: an
 * unknown outcome raises `AuditPublishAmbiguousError` and is reconciled by the caller.
 */
export class HcsAuditPublisher implements AuditPublisher {
  readonly available = true;
  readonly network: string;
  readonly topicId: string;
  private client?: Client;
  constructor(private config: AuditConfig) {
    this.network = config.network;
    this.topicId = config.topicId;
  }

  private connect(): Client {
    if (!this.client) {
      // The signer is server-side only. Neither the key nor the parsed object is ever logged,
      // returned by an API, or written to an audit payload.
      const client = Client.forName(this.config.network);
      client.setOperator(this.config.operatorId, parseAuditKey(this.config.operatorKey!, this.config.keyType));
      client.setRequestTimeout(this.config.requestTimeoutMs);
      this.client = client;
    }
    return this.client;
  }

  async publish(message: string): Promise<PublishResult> {
    if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) throw new AuditPublishRejectedError('audit_message_too_large');
    const client = this.connect();
    let response;
    try {
      response = await new TopicMessageSubmitTransaction()
        .setTopicId(this.config.topicId)
        // Statements are bounded well under one message, so a chunked submission would mean the
        // schema changed without this limit being revisited. Refuse rather than split silently.
        .setMaxChunks(1)
        .setMessage(message)
        .execute(client);
    } catch (error) {
      const status = statusOf(error);
      // A precheck rejection is answered by a node before the transaction can reach consensus,
      // so nothing was published and the outcome is not in doubt.
      if (error instanceof PrecheckStatusError) {
        if (PERMANENT.has(status!)) throw new AuditPublishRejectedError(status!);
        throw new AuditPublishUnavailableError(status!);
      }
      // Anything else leaves it genuinely unknown whether a node accepted the transaction.
      throw new AuditPublishAmbiguousError(reasonOf(error));
    }
    const transactionId = response.transactionId.toString();
    try {
      const record = await response.getRecord(client);
      const sequenceNumber = record.receipt.topicSequenceNumber;
      if (record.receipt.status.toString() !== 'SUCCESS' || sequenceNumber === null) {
        throw new AuditPublishAmbiguousError(`receipt_${record.receipt.status.toString()}`, transactionId);
      }
      return { transactionId, consensusAt: record.consensusTimestamp.toDate(), sequenceNumber: sequenceNumber.toString() };
    } catch (error) {
      if (error instanceof AuditPublishAmbiguousError) throw error;
      const status = statusOf(error);
      // A receipt status means the transaction did reach consensus and failed there.
      if (error instanceof ReceiptStatusError) {
        if (PERMANENT.has(status!)) throw new AuditPublishRejectedError(status!);
        throw new AuditPublishUnavailableError(status!);
      }
      // The transaction was accepted by a node and its result never came back to this process.
      throw new AuditPublishAmbiguousError(reasonOf(error), transactionId);
    }
  }

  close() { this.client?.close(); this.client = undefined; }
}

/** Nothing is configured. The outbox still records every statement, so it can be published later. */
export class UnconfiguredAuditPublisher implements AuditPublisher {
  readonly available = false;
  readonly network = '';
  readonly topicId = '';
  async publish(): Promise<PublishResult> { throw new AuditPublishUnavailableError('audit_not_configured'); }
  close() { /* nothing to close */ }
}

/** Fixed codes only: a facilitator or node message is never echoed into a stored failure reason. */
function reasonOf(error: unknown): string {
  const status = statusOf(error);
  if (status) return status;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'network_or_node_error';
}

// ---------------------------------------------------------------------------
// Mirror node. Read-only, public, and the surface a third party uses to check
// the published contents for themselves.
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  consensus_timestamp: z.string(),
  message: z.string(),
  payer_account_id: z.string(),
  running_hash: z.string(),
  sequence_number: z.number(),
  topic_id: z.string(),
});
const messagesSchema = z.object({
  messages: z.array(messageSchema),
  links: z.object({ next: z.string().nullable().optional() }).optional(),
});
const topicSchema = z.object({
  topic_id: z.string(),
  memo: z.string().optional(),
  deleted: z.boolean().nullable().optional(),
  admin_key: z.object({ _type: z.string(), key: z.string() }).nullable().optional(),
  submit_key: z.object({ _type: z.string(), key: z.string() }).nullable().optional(),
});

export type MirrorMessage = {
  consensusTimestamp: string; sequenceNumber: string; payerAccountId: string;
  runningHash: string; contents: string;
};
export type MirrorTopic = z.infer<typeof topicSchema>;

/** A consensus timestamp is `seconds.nanos`; a Date is the nearest millisecond of it. */
export function consensusDate(timestamp: string): Date {
  const [seconds, nanos = '0'] = timestamp.split('.');
  return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos.padEnd(9, '0')) / 1_000_000));
}

/** HashScan addresses a transaction with dashes where the SDK prints `@` and `.`. */
export function explorerTransactionId(transactionId: string): string {
  return transactionId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

const decode = (message: z.infer<typeof messageSchema>): MirrorMessage => ({
  consensusTimestamp: message.consensus_timestamp,
  sequenceNumber: message.sequence_number.toString(),
  payerAccountId: message.payer_account_id,
  runningHash: message.running_hash,
  contents: Buffer.from(message.message, 'base64').toString('utf8'),
});

export class MirrorNodeReader {
  constructor(private baseUrl: string, private timeoutMs = 15_000) {}

  private async get(path: string): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`mirror_http_${response.status}`);
    return response.json();
  }

  messageUrl(topicId: string, sequenceNumber: string): string {
    return new URL(`/api/v1/topics/${topicId}/messages/${sequenceNumber}`, this.baseUrl).toString();
  }

  /** One published message by its topic sequence number. This is the verifiable readback. */
  async message(topicId: string, sequenceNumber: string): Promise<MirrorMessage | undefined> {
    const body = await this.get(`/api/v1/topics/${topicId}/messages/${sequenceNumber}`);
    if (body === undefined) return undefined;
    return decode(messageSchema.parse(body));
  }

  /**
   * Finds a statement by its stable event id, which is what resolves an unknown submission
   * outcome without re-sending anything. Bounded: the trail is small and a wider search would
   * not make an older, undiscovered message any more useful.
   */
  async findByEventId(topicId: string, eventId: string, pages = 5): Promise<MirrorMessage | undefined> {
    let path: string | undefined = `/api/v1/topics/${topicId}/messages?order=desc&limit=100`;
    for (let page = 0; page < pages && path; page++) {
      const body: unknown = await this.get(path);
      if (body === undefined) return undefined;
      const parsed = messagesSchema.parse(body);
      for (const entry of parsed.messages) {
        const decoded = decode(entry);
        if (decoded.contents.includes(eventId)) return decoded;
      }
      path = parsed.links?.next ?? undefined;
    }
    return undefined;
  }

  async topic(topicId: string): Promise<MirrorTopic | undefined> {
    const body = await this.get(`/api/v1/topics/${topicId}`);
    return body === undefined ? undefined : topicSchema.parse(body);
  }
}
