import type { AuditEvent, Prisma, PrismaClient } from '@prisma/client';
import type { AuditConfig } from '../config.js';
import {
  AUDIT_DELIVERY_NOTE, AUDIT_DISCLOSURE, AUDIT_SCHEMA, AUDIT_TYPES, auditMessageSchema,
  encodeAuditMessage, type AuditRecord,
} from './events.js';
import {
  AuditPublishAmbiguousError, AuditPublishRejectedError, consensusDate, explorerTransactionId,
  type AuditPublisher, type MirrorNodeReader,
} from './hcs.js';

/** PENDING and PUBLISHING are in flight; UNCONFIRMED is unknown; only PUBLISHED is confirmed. */
export const AUDIT_OPEN = ['PENDING', 'PUBLISHING', 'UNCONFIRMED'] as const;

export type AuditDependencies = {
  db: PrismaClient;
  config: AuditConfig;
  publisher: AuditPublisher;
  mirror: MirrorNodeReader;
  /** Wakes the publisher after a workflow transition commits. Never allowed to fail the caller. */
  enqueue?: (requestId: string) => Promise<void>;
  now?: () => Date;
};

export type PublishReport = { status: 'published' | 'idle' | 'blocked' | 'not_configured'; published: number; pending: number };

export class AuditService {
  constructor(private deps: AuditDependencies) {}

  get publishing(): boolean { return this.deps.publisher.available; }
  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /**
   * Writes one statement to the outbox, inside the caller's transaction.
   *
   * Idempotent by construction: both keys — the derived event id and the derived per-request
   * sequence — are functions of the request and the event type, so a redelivered workflow step
   * writes nothing new and can never raise a unique-constraint error inside a transaction that
   * is settling a payment or recording a deployment.
   */
  async record(tx: Prisma.TransactionClient, record: AuditRecord): Promise<void> {
    // Validated and size-checked here, in the workflow transaction, so a statement that could
    // never be published is refused at the point where the fault is still visible.
    const payload = JSON.parse(encodeAuditMessage(record.message)) as Prisma.InputJsonValue;
    await tx.auditEvent.createMany({
      data: [{
        requestId: record.requestId, eventId: record.eventId, type: record.type,
        schemaVersion: AUDIT_SCHEMA, sequence: record.sequence, payload,
        occurredAt: record.occurredAt, backfilled: record.backfilled, status: 'PENDING',
        network: this.deps.config.network, topicId: this.deps.config.topicId || null,
        nextAttemptAt: this.now(),
      }],
      skipDuplicates: true,
    });
  }

  /** Best effort. A queue that cannot be reached only delays publication; the sweep recovers it. */
  async notify(requestId: string): Promise<void> {
    try { await this.deps.enqueue?.(requestId); }
    catch { /* The outbox is durable; the periodic sweep picks this request up. */ }
  }

  /** Requests with outbox work that is due now, oldest first. Drives the periodic sweep. */
  async due(limit = 20): Promise<string[]> {
    const now = this.now();
    const rows = await this.deps.db.auditEvent.findMany({
      where: { status: { in: [...AUDIT_OPEN] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      select: { requestId: true }, orderBy: [{ createdAt: 'asc' }], take: limit * 8,
    });
    return [...new Set(rows.map(row => row.requestId))].slice(0, limit);
  }

  private backoff(attempts: number): Date {
    const delay = Math.min(this.deps.config.retryBaseMs * 2 ** Math.max(0, attempts - 1), this.deps.config.retryMaxMs);
    return new Date(this.now().getTime() + delay);
  }

  /**
   * Publishes one request's outstanding statements, in order.
   *
   * Order is preserved by stopping at the first statement that does not reach a confirmed state:
   * a payment that could not be published never lets the market creation that followed it appear
   * on the topic first. Nothing here touches the creation workflow, so an unreachable topic
   * delays the trail and changes nothing about payments, deployments or what a user sees.
   */
  async publishRequest(requestId: string): Promise<PublishReport> {
    if (!this.deps.publisher.available) return { status: 'not_configured', published: 0, pending: 0 };
    const now = this.now();
    const events = await this.deps.db.auditEvent.findMany({
      where: { requestId, status: { in: [...AUDIT_OPEN] } }, orderBy: { sequence: 'asc' },
    });
    let published = 0;
    let blocked = false;
    for (const event of events) {
      if (event.nextAttemptAt && event.nextAttemptAt > now) { blocked = true; break; }
      // Compare-and-set on the attempt counter as well as the status, so two workers cannot both
      // decide to submit the same statement.
      const claimed = await this.deps.db.auditEvent.updateMany({
        where: { id: event.id, status: event.status, attempts: event.attempts },
        data: { status: 'PUBLISHING', attempts: { increment: 1 }, nextAttemptAt: this.backoff(event.attempts + 1) },
      });
      if (claimed.count !== 1) { blocked = true; break; }
      const settled = await this.attempt({ ...event, attempts: event.attempts + 1 });
      if (settled) published++; else { blocked = true; break; }
    }
    const pending = await this.deps.db.auditEvent.count({ where: { requestId, status: { in: [...AUDIT_OPEN] } } });
    if (blocked) return { status: 'blocked', published, pending };
    return { status: published > 0 ? 'published' : 'idle', published, pending };
  }

  /** Returns true only when the statement is confirmed on the topic. */
  private async attempt(event: AuditEvent): Promise<boolean> {
    const config = this.deps.config;
    // A statement that was already submitted once — this row was PUBLISHING or UNCONFIRMED — is
    // looked up before anything is sent again, so an unknown outcome does not become a duplicate
    // whenever the mirror node can answer.
    if (event.status !== 'PENDING' && await this.reconcile(event)) return true;
    let message: string;
    try { message = encodeAuditMessage(event.payload); }
    catch { await this.fail(event, 'audit_message_invalid'); return false; }
    try {
      const result = await this.deps.publisher.publish(message);
      await this.deps.db.auditEvent.update({
        where: { id: event.id },
        data: {
          status: 'PUBLISHED', network: config.network, topicId: config.topicId,
          transactionId: result.transactionId, consensusAt: result.consensusAt,
          sequenceNumber: result.sequenceNumber, failureCode: null, nextAttemptAt: null,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof AuditPublishRejectedError) { await this.fail(event, error.reason); return false; }
      if (error instanceof AuditPublishAmbiguousError) {
        // Never reported as published and never blindly retried. Parked as unknown, with the
        // transaction id when the node returned one, for reconciliation on the next pass.
        const exhausted = event.attempts >= config.maxAttempts;
        await this.deps.db.auditEvent.update({
          where: { id: event.id },
          data: {
            status: 'UNCONFIRMED', transactionId: event.transactionId ?? error.transactionId ?? null,
            failureCode: exhausted ? 'audit_publication_unconfirmed' : error.reason.slice(0, 120),
            nextAttemptAt: exhausted ? null : this.backoff(event.attempts),
          },
        });
        return false;
      }
      if (event.attempts >= config.maxAttempts) { await this.fail(event, 'audit_publication_exhausted'); return false; }
      const reason = error instanceof Error && 'reason' in error ? String((error as { reason: unknown }).reason) : 'audit_publish_failed';
      await this.deps.db.auditEvent.update({
        where: { id: event.id },
        data: { status: 'PENDING', failureCode: reason.slice(0, 120), nextAttemptAt: this.backoff(event.attempts) },
      });
      return false;
    }
  }

  private async fail(event: AuditEvent, code: string): Promise<void> {
    await this.deps.db.auditEvent.update({
      where: { id: event.id }, data: { status: 'FAILED', failureCode: code, nextAttemptAt: null },
    });
  }

  /**
   * Resolves an unknown submission against the mirror node. A statement that is already on the
   * topic is recorded with the consensus timestamp and sequence number it actually has, rather
   * than being sent a second time.
   */
  private async reconcile(event: AuditEvent): Promise<boolean> {
    const topicId = event.topicId ?? this.deps.config.topicId;
    if (!topicId) return false;
    let found;
    try { found = await this.deps.mirror.findByEventId(topicId, event.eventId); }
    catch { return false; }
    if (!found) return false;
    await this.deps.db.auditEvent.update({
      where: { id: event.id },
      data: {
        status: 'PUBLISHED', network: this.deps.config.network, topicId,
        consensusAt: consensusDate(found.consensusTimestamp), sequenceNumber: found.sequenceNumber,
        failureCode: null, nextAttemptAt: null,
      },
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Reading the trail.
  // -------------------------------------------------------------------------

  async trail(requestId: string): Promise<AuditEvent[]> {
    return this.deps.db.auditEvent.findMany({ where: { requestId }, orderBy: { sequence: 'asc' } });
  }

  private links(event: AuditEvent) {
    const topicId = event.topicId ?? this.deps.config.topicId;
    const base = this.deps.config.explorerBase.replace(/\/$/, '');
    return {
      topicUrl: topicId ? `${base}/topic/${topicId}` : null,
      transactionUrl: event.transactionId ? `${base}/transaction/${explorerTransactionId(event.transactionId)}` : null,
      // The readback a third party can perform without trusting this API at all.
      mirrorUrl: topicId && event.sequenceNumber ? this.deps.mirror.messageUrl(topicId, event.sequenceNumber) : null,
    };
  }

  /** Public view of the trail. Every field here is already public elsewhere in the request. */
  present(events: AuditEvent[]) {
    const config = this.deps.config;
    return {
      available: this.publishing,
      schema: AUDIT_SCHEMA,
      network: config.network,
      topicId: this.publishing ? config.topicId : null,
      topicUrl: this.publishing ? `${config.explorerBase.replace(/\/$/, '')}/topic/${config.topicId}` : null,
      mirrorNodeUrl: config.mirrorNodeUrl,
      types: [...AUDIT_TYPES],
      delivery: 'at_least_once' as const,
      deliveryNote: AUDIT_DELIVERY_NOTE,
      note: AUDIT_DISCLOSURE,
      events: events.map(event => ({
        eventId: event.eventId, type: event.type, sequence: event.sequence,
        status: event.status, attempts: event.attempts,
        occurredAt: event.occurredAt,
        // Null unless the message reached consensus. A pending statement never borrows a time.
        consensusAt: event.consensusAt, transactionId: event.transactionId,
        sequenceNumber: event.sequenceNumber, failureCode: event.failureCode,
        backfilled: event.backfilled,
        // Stated on the row itself so a backfilled statement is never read as having happened
        // at its consensus timestamp.
        timestampNote: event.backfilled
          ? 'Recorded after the fact: the consensus timestamp is when Horizon published this statement, not when the event happened.'
          : null,
        payload: event.payload,
        ...this.links(event),
      })),
    };
  }

  /**
   * Reads each confirmed statement back from the mirror node and compares it, byte for byte,
   * with what this service holds. The comparison is against the canonical re-encoding, which is
   * exactly what was submitted, so a mismatch means the contents differ and not the key order.
   */
  async verify(events: AuditEvent[]) {
    const results = [];
    for (const event of events) {
      const topicId = event.topicId ?? this.deps.config.topicId;
      if (event.status !== 'PUBLISHED' || !event.sequenceNumber || !topicId) {
        results.push({ eventId: event.eventId, checked: false, matches: false, reason: 'not_published' });
        continue;
      }
      let expected: string;
      try { expected = encodeAuditMessage(event.payload); }
      catch { results.push({ eventId: event.eventId, checked: false, matches: false, reason: 'stored_payload_invalid' }); continue; }
      try {
        const message = await this.deps.mirror.message(topicId, event.sequenceNumber);
        if (!message) { results.push({ eventId: event.eventId, checked: true, matches: false, reason: 'not_found_on_topic' }); continue; }
        const parsed = auditMessageSchema.safeParse(JSON.parse(message.contents) as unknown);
        results.push({
          eventId: event.eventId, checked: true, matches: message.contents === expected,
          reason: message.contents === expected ? null : 'contents_differ',
          consensusTimestamp: message.consensusTimestamp, sequenceNumber: message.sequenceNumber,
          payerAccountId: message.payerAccountId, runningHash: message.runningHash,
          // A message that no longer parses under the published schema is reported as such rather
          // than compared field by field against a shape it does not have.
          schemaValid: parsed.success,
          url: this.deps.mirror.messageUrl(topicId, event.sequenceNumber),
        });
      } catch {
        results.push({ eventId: event.eventId, checked: false, matches: false, reason: 'mirror_unavailable' });
      }
    }
    return results;
  }
}
