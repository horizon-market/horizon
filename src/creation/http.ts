import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { CreationService, WorkflowError } from './service.js';
import { proofSchema } from '../world/verifier.js';
import { serialize } from '../trading/http.js';

const draftRequestSchema = z.object({
  question: z.string().trim().min(15).max(200),
  requesterKind: z.enum(['browser', 'agent']),
  requester: z.string().trim().min(3).max(128),
  category: z.string().trim().min(2).max(40).optional(),
  closeAt: z.string().datetime().optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
}).strict();
const approvalSchema = z.object({ draftHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const verificationSchema = z.object({ proof: proofSchema }).strict();

const bearer = (req: Request) => {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
};

type PublicRequest = Awaited<ReturnType<CreationService['get']>>;

/** Public view of a creation request. The stored token hash is never exposed. */
export function present(request: PublicRequest) {
  return {
    id: request.id, status: request.status, question: request.question, requesterKind: request.requesterKind,
    requester: request.requester, draft: request.draft, draftHash: request.draftHash,
    draftProvider: request.draftProvider, draftMode: request.draftMode, review: request.duplicates,
    approvedAt: request.approvedAt, approvedHash: request.approvedHash,
    discountBps: request.discountBps, discountNote: request.discountNote, priceUnits: request.priceUnits,
    marketAddress: request.marketAddress, creationTxHash: request.creationTxHash,
    failureCode: request.failureCode, attempts: request.attempts,
    createdAt: request.createdAt, updatedAt: request.updatedAt,
    verification: request.verification && { credentialType: request.verification.credentialType, verifier: request.verification.verifier, verifiedAt: request.verification.verifiedAt },
    payment: request.payment && {
      status: request.payment.status, network: request.payment.network, asset: request.payment.asset,
      amountUnits: request.payment.amountUnits, payTo: request.payment.payTo, facilitator: request.payment.facilitator,
      transactionRef: request.payment.transactionRef, payer: request.payment.payer, settledAt: request.payment.settledAt,
      failureCode: request.payment.failureCode, attempts: request.payment.attempts,
    },
    // Trading is free; this charge buys the creation service only.
    fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
  };
}

export function creationRoutes(service?: CreationService) {
  const router = Router();
  if (!service) {
    router.use((_req, res) => res.status(503).json({ error: 'creation_not_configured' }));
    return router;
  }
  const drafting = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
  const steps = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const fail = (res: Parameters<Parameters<Router['post']>[1]>[1], error: unknown) => {
    if (error instanceof WorkflowError) { res.status(error.httpStatus).json({ error: error.code }); return; }
    console.error('Creation request failed; internal details withheld');
    res.status(500).json({ error: 'internal_error' });
  };

  router.post('/requests', drafting, async (req, res) => {
    const input = draftRequestSchema.safeParse(req.body);
    const idempotencyKey = req.get('idempotency-key')?.trim() || input.data?.idempotencyKey;
    if (!input.success || !idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      res.status(400).json({ error: 'invalid_creation_request' });
      return;
    }
    try {
      const result = await service.createDraft({ ...input.data, idempotencyKey });
      res.status(result.replay ? 200 : 201).json(serialize({ request: present(result.request), accessToken: result.token, replay: result.replay }));
    } catch (error) { fail(res, error); }
  });

  router.get('/requests/:id', steps, async (req, res) => {
    try { res.json(serialize({ request: present(await service.get(req.params.id!, bearer(req))) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/approval', steps, async (req, res) => {
    const input = approvalSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_approval' }); return; }
    try { res.json(serialize({ request: present(await service.approve(req.params.id!, bearer(req), input.data.draftHash)) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/verification', steps, async (req, res) => {
    const input = verificationSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_proof' }); return; }
    try { res.json(serialize({ request: present(await service.verify(req.params.id!, bearer(req), input.data.proof)) })); }
    catch (error) { fail(res, error); }
  });

  /**
   * One x402 resource. Without a payment header it answers 402 with the requirements for this
   * exact request; with one it verifies and settles. Both browser and agent clients use it.
   */
  router.post('/requests/:id/payment', steps, async (req, res) => {
    const id = req.params.id!, token = bearer(req);
    const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}/api/creation/requests/${id}/payment`;
    const header = req.get('x-payment');
    try {
      if (!header) {
        const issued = await service.requirePayment(id, token, resource);
        if (issued.payment.status === 'SETTLED') { res.json(serialize({ paid: true, request: present(issued.request) })); return; }
        res.status(402).json(serialize({
          x402Version: 2, error: 'payment_required', accepts: [service.requirements(issued.payment, resource)],
          request: present(issued.request),
        }));
        return;
      }
      const settled = await service.submitPayment(id, token, header, resource);
      if (settled.settlement) res.setHeader('x-payment-response', Buffer.from(JSON.stringify(settled.settlement)).toString('base64'));
      res.json(serialize({ paid: true, replay: settled.replay, request: present(settled.request) }));
    } catch (error) { fail(res, error); }
  });

  return router;
}
