import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PaymentsConfig, WorldConfig } from '../config.js';
import { creationPrice, utcDay } from './pricing.js';
import { draftHash, draftSchema, DraftError, type MarketContext, type MarketDraft, type MarketDraftProvider } from './types.js';
import { buildRequirements, decodePayment, paymentMatches, paymentNonce, payloadFingerprint, PaymentPayloadError, PaymentRejectedError, SettlementAmbiguousError, type PaymentFacilitator } from '../payments/x402.js';
import { createRpContext, proofSchema, VerificationRejectedError, VerificationUnavailableError, type HumanVerifier, type VerificationProof } from '../world/verifier.js';
import type { MarketDeployer } from './onchain.js';

export const STATUSES = ['DRAFT', 'APPROVED', 'PAYMENT_REQUIRED', 'PAYMENT_REVIEW', 'PAID', 'CREATING', 'CREATED', 'FAILED'] as const;
export type Status = typeof STATUSES[number];
export type Event = 'approve' | 'require_payment' | 'settle' | 'review' | 'start_creation' | 'created' | 'fail' | 'retry';

/** The workflow only moves along declared edges, so no step can be skipped by an API caller. */
export const TRANSITIONS: Record<Status, Partial<Record<Event, Status>>> = {
  DRAFT: { approve: 'APPROVED' },
  APPROVED: { require_payment: 'PAYMENT_REQUIRED' },
  PAYMENT_REQUIRED: { settle: 'PAID', review: 'PAYMENT_REVIEW' },
  PAYMENT_REVIEW: { settle: 'PAID' },
  PAID: { start_creation: 'CREATING' },
  CREATING: { created: 'CREATED', fail: 'FAILED' },
  FAILED: { retry: 'CREATING' },
  CREATED: {},
};

export class WorkflowError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); }
}

export function transition(status: Status, event: Event): Status {
  const next = TRANSITIONS[status]?.[event];
  if (!next) throw new WorkflowError(`invalid_transition_${status.toLowerCase()}_${event}`);
  return next;
}

export type CreationDependencies = {
  db: PrismaClient; provider: MarketDraftProvider; verifier: HumanVerifier; facilitator: PaymentFacilitator;
  payments: PaymentsConfig; world: WorldConfig; deployer?: MarketDeployer;
  context: () => Promise<{ available: boolean; context: MarketContext }>;
  enqueue?: (requestId: string) => Promise<void>;
  closeBounds?: { minSeconds: number; maxSeconds: number };
};

export type CreateDraftInput = { idempotencyKey: string; question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string };

const hashToken = (token: string) => createHash('sha256').update(token).digest();

export class CreationService {
  constructor(private deps: CreationDependencies) {}

  private bounds() { return this.deps.closeBounds ?? { minSeconds: 3600, maxSeconds: 365 * 24 * 3600 }; }

  private authorize(request: { accessTokenHash: string }, token: string | undefined) {
    const expected = Buffer.from(request.accessTokenHash, 'hex');
    if (!token || expected.length !== 32) throw new WorkflowError('unauthorized', 401);
    const actual = hashToken(token);
    if (!timingSafeEqual(actual, expected)) throw new WorkflowError('unauthorized', 401);
  }

  private async load(id: string, token: string | undefined) {
    const request = await this.deps.db.creationRequest.findUnique({ where: { id }, include: { payment: true, verification: true } });
    if (!request) throw new WorkflowError('unknown_request', 404);
    this.authorize(request, token);
    return request;
  }

  private validateCloseAt(draft: MarketDraft) {
    const closeAt = Math.floor(new Date(draft.closeAt).getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    const { minSeconds, maxSeconds } = this.bounds();
    if (!Number.isFinite(closeAt) || closeAt <= now + minSeconds || closeAt > now + maxSeconds) throw new WorkflowError('draft_close_time_out_of_range', 422);
    return closeAt;
  }

  /** Draft creation is idempotent by key: a retried request never produces a second draft. */
  async createDraft(input: CreateDraftInput) {
    const existing = await this.deps.db.creationRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { payment: true, verification: true } });
    if (existing) return { request: existing, token: undefined, replay: true };
    const { available, context } = await this.deps.context();
    let result;
    try { result = await this.deps.provider.draft({ question: input.question, category: input.category, closeAt: input.closeAt, requesterKind: input.requesterKind }, context); }
    catch (error) { throw new WorkflowError(error instanceof DraftError ? error.message : 'draft_failed', 502); }
    this.validateCloseAt(result.draft);
    const token = randomBytes(32).toString('hex');
    const created = await this.deps.db.creationRequest.create({
      data: {
        idempotencyKey: input.idempotencyKey, question: result.draft.question, requesterKind: input.requesterKind,
        requester: input.requester, accessTokenHash: hashToken(token).toString('hex'), status: 'DRAFT',
        draft: result.draft as unknown as Prisma.InputJsonValue, draftHash: draftHash(result.draft),
        draftProvider: result.provider, draftMode: result.mode,
        duplicates: { duplicateCheck: available ? 'live_graph' : 'unavailable_not_configured', groundedOnBlock: result.groundedOnBlock,
          rationale: result.rationale, warnings: result.duplicates } as unknown as Prisma.InputJsonValue,
      },
      include: { payment: true, verification: true },
    });
    return { request: created, token, replay: false };
  }

  async get(id: string, token: string | undefined) { return this.load(id, token); }

  async worldContext(id: string, token: string | undefined) {
    const request = await this.load(id, token);
    if (request.status !== 'APPROVED') throw new WorkflowError('verification_not_available_for_status', 409);
    try { return createRpContext(this.deps.world); }
    catch { throw new WorkflowError('verification_unavailable', 503); }
  }

  /** A human approves the exact reviewed draft; a changed draft invalidates the approval hash. */
  async approve(id: string, token: string | undefined, approvedHash: string) {
    const request = await this.load(id, token);
    if (request.status === 'APPROVED' && request.approvedHash === approvedHash) return request;
    const status = transition(request.status as Status, 'approve');
    if (!request.draftHash || request.draftHash !== approvedHash) throw new WorkflowError('draft_hash_mismatch', 422);
    this.validateCloseAt(draftSchema.parse(request.draft));
    return this.deps.db.creationRequest.update({
      where: { id, status: request.status }, data: { status, approvedAt: new Date(), approvedHash },
      include: { payment: true, verification: true },
    });
  }

  /** Verification is optional. It only affects price after the server confirms the credential. */
  async verify(id: string, token: string | undefined, proof: VerificationProof) {
    const request = await this.load(id, token);
    if (request.payment) throw new WorkflowError('verification_after_payment_requirements', 409);
    if (!this.deps.verifier.available) throw new WorkflowError('verification_unavailable', 503);
    let result;
    try { result = await this.deps.verifier.verify(proofSchema.parse(proof), id); }
    catch (error) {
      if (error instanceof VerificationUnavailableError) throw new WorkflowError('verification_unavailable', 503);
      if (error instanceof VerificationRejectedError) throw new WorkflowError('verification_rejected', 422);
      throw new WorkflowError('verification_failed', 502);
    }
    await this.deps.db.humanVerification.upsert({
      where: { requestId: id },
      create: { requestId: id, nullifierHash: result.nullifierHash, credentialType: result.credentialType, verifier: result.verifier },
      update: { nullifierHash: result.nullifierHash, credentialType: result.credentialType, verifier: result.verifier },
    });
    return this.load(id, token);
  }

  /**
   * Issues x402 requirements once per request. The amount is decided here, together with the
   * bounded discount entitlement, and never recomputed for an existing intent.
   */
  async requirePayment(id: string, token: string | undefined, resource: string) {
    const request = await this.load(id, token);
    if (request.payment) return { request, payment: request.payment, replay: true };
    transition(request.status as Status, 'require_payment');
    if (!this.deps.payments.payTo) throw new WorkflowError('payment_receiver_not_configured', 503);
    const verification = request.verification;
    const day = utcDay();
    const result = await this.deps.db.$transaction(async tx => {
      let eligible = false, note = 'No verified credential is attached to this request, so the standard creation price applies.';
      if (verification) {
        // Bounded entitlement: one discounted creation per credential per UTC day.
        const claimed = await tx.discountUsage.createMany({ data: [{ nullifierHash: verification.nullifierHash, day, requestId: id }], skipDuplicates: true });
        eligible = claimed.count === 1;
        note = eligible
          ? `Verified ${verification.credentialType} credential; the human discount applies once per credential per UTC day.`
          : 'This credential already used its discounted creation today, so the standard price applies.';
      }
      const price = creationPrice(this.deps.payments.priceUnits, this.deps.payments.discountBps, eligible);
      const payment = await tx.paymentIntent.create({
        data: {
          requestId: id, status: 'REQUIRED', network: this.deps.payments.network, asset: this.deps.payments.asset,
          amountUnits: price.payableUnits.toString(), payTo: this.deps.payments.payTo, nonce: paymentNonce(),
          facilitator: this.deps.facilitator.name,
        },
      });
      const updated = await tx.creationRequest.update({
        where: { id, status: request.status },
        data: { status: 'PAYMENT_REQUIRED', discountBps: price.discountBps, discountNote: note, priceUnits: price.payableUnits.toString() },
        include: { payment: true, verification: true },
      });
      return { request: updated, payment };
    });
    return { ...result, replay: false, resource };
  }

  async requirements(payment: { amountUnits: string; nonce: string }) {
    const base = buildRequirements(this.deps.payments, { amountUnits: BigInt(payment.amountUnits), nonce: payment.nonce });
    try { return await this.deps.facilitator.prepare(base); }
    catch { throw new WorkflowError('payment_facilitator_unavailable', 503); }
  }

  /**
   * Settles one x402 payment. Concurrent or repeated submissions never settle twice: the intent
   * is claimed with a compare-and-set, an already settled intent replies with the stored receipt,
   * and an ambiguous facilitator result is parked for reconciliation instead of being retried.
   */
  async submitPayment(id: string, token: string | undefined, header: string, resource: string) {
    const request = await this.load(id, token);
    const payment = request.payment;
    if (!payment) throw new WorkflowError('payment_not_required_yet', 409);
    if (payment.status === 'SETTLED') return { request, payment, settlement: undefined, replay: true };
    if (payment.status === 'REVIEW') throw new WorkflowError('payment_awaiting_reconciliation', 409);
    if (payment.status === 'SUBMITTED') throw new WorkflowError('payment_in_progress_reconcile', 409);
    let payload;
    try { payload = decodePayment(header); }
    catch (error) { throw new WorkflowError(error instanceof PaymentPayloadError ? error.message : 'payment_payload_invalid', 400); }
    const requirements = await this.requirements(payment);
    if (payload.accepted.network !== requirements.network) throw new WorkflowError('payment_network_mismatch', 400);
    if (!paymentMatches(payload, requirements)) throw new WorkflowError('payment_requirements_mismatch', 400);
    const claimed = await this.deps.db.paymentIntent.updateMany({
      where: { id: payment.id, status: { in: ['REQUIRED', 'FAILED'] } },
      data: { status: 'SUBMITTED', attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new WorkflowError('payment_in_progress_reconcile', 409);
    const verified = await this.deps.facilitator.verify(payload, requirements);
    if (!verified.valid) {
      await this.deps.db.paymentIntent.update({ where: { id: payment.id }, data: { status: 'FAILED', failureCode: verified.reason ?? 'payment_invalid' } });
      throw new WorkflowError('payment_invalid', 402);
    }
    let settled;
    try { settled = await this.deps.facilitator.settle(payload, requirements); }
    catch (error) {
      if (error instanceof SettlementAmbiguousError) {
        const evidence = `settlement_ambiguous:${error.reason}`.slice(0, 200);
        await this.deps.db.$transaction([
          this.deps.db.paymentIntent.update({ where: { id: payment.id }, data: { status: 'REVIEW', failureCode: evidence } }),
          this.deps.db.creationRequest.update({ where: { id }, data: { status: 'PAYMENT_REVIEW' } }),
        ]);
        throw new WorkflowError('payment_awaiting_reconciliation', 409);
      }
      const reason = error instanceof PaymentRejectedError ? error.reason : 'settlement_failed';
      await this.deps.db.paymentIntent.update({ where: { id: payment.id }, data: { status: 'FAILED', failureCode: reason.slice(0, 200) } });
      throw new WorkflowError('payment_declined', 402);
    }
    try {
      const [updatedPayment, updatedRequest] = await this.deps.db.$transaction([
        this.deps.db.paymentIntent.update({
          where: { id: payment.id },
          data: { status: 'SETTLED', transactionRef: settled.transaction, payer: settled.payer, payloadHash: payloadFingerprint(header), settledAt: new Date(), failureCode: null },
        }),
        this.deps.db.creationRequest.update({ where: { id }, data: { status: 'PAID' }, include: { payment: true, verification: true } }),
      ]);
      await this.deps.enqueue?.(id).catch(() => undefined);
      return { request: updatedRequest, payment: updatedPayment, settlement: settled, replay: false };
    } catch (error) {
      // A duplicate settlement reference or payload means this money was already accounted for.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.deps.db.paymentIntent.update({ where: { id: payment.id }, data: { status: 'REVIEW', failureCode: 'duplicate_settlement_reference' } });
        throw new WorkflowError('payment_replayed', 409);
      }
      throw error;
    }
  }

  /** Runs the paid creation step. Safe to retry: the registry is checked before any broadcast. */
  async runCreation(id: string) {
    const request = await this.deps.db.creationRequest.findUnique({ where: { id }, include: { payment: true } });
    if (!request) throw new WorkflowError('unknown_request', 404);
    if (request.status === 'CREATED') return request;
    if (request.payment?.status !== 'SETTLED') throw new WorkflowError('creation_before_settlement');
    if (!this.deps.deployer) throw new WorkflowError('creation_not_configured', 503);
    const status = transition(request.status as Status, request.status === 'FAILED' ? 'retry' : 'start_creation');
    await this.deps.db.creationRequest.update({ where: { id }, data: { status, attempts: { increment: 1 }, failureCode: null, failureDetail: null } });
    const draft = draftSchema.parse(request.draft);
    if (request.approvedHash !== draftHash(draft)) throw new WorkflowError('draft_not_approved');
    try {
      const created = await this.deps.deployer.create({
        requestId: id, question: draft.question, rules: draft.rules, evidenceSource: draft.evidenceSource,
        closeAt: Math.floor(new Date(draft.closeAt).getTime() / 1000),
      });
      return await this.deps.db.creationRequest.update({
        where: { id }, data: { status: 'CREATED', marketAddress: created.market, creationTxHash: created.transactionHash ?? request.creationTxHash },
      });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'creation_failed';
      await this.deps.db.creationRequest.update({ where: { id }, data: { status: 'FAILED', failureCode: 'creation_failed', failureDetail: code } });
      throw error;
    }
  }
}
