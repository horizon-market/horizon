import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { CreationService, WorkflowError } from './service.js';
import { ImportError } from '../imports/polymarket.js';
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

const requester = z.object({
  requesterKind: z.enum(['browser', 'agent']),
  requester: z.string().trim().min(3).max(128),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});
/** Only a Polymarket page address is accepted, and only the backend ever fetches from it. */
const importUrlSchema = z.string().trim().min(10).max(2048);
const previewSchema = z.object({ url: importUrlSchema }).strict();
const positionsSchema = z.array(z.number().int().min(0).max(63)).min(1).max(24);
const importSchema = requester.extend({ url: importUrlSchema, positions: positionsSchema.optional() }).strict();
const groupSchema = requester.extend({
  event: z.object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(4000).optional(),
    category: z.string().trim().min(2).max(40).optional(),
    exclusivity: z.enum(['COLLECTION', 'EXCLUSIVE']),
    outcomesComplete: z.boolean().optional(),
  }).strict(),
  children: z.array(z.object({
    question: z.string().trim().min(15).max(200),
    outcomeLabel: z.string().trim().min(1).max(80),
    closeAt: z.string().datetime().optional(),
  }).strict()).min(1).max(24),
}).strict();
const selectionSchema = z.object({ positions: positionsSchema }).strict();

const bearer = (req: Request) => {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
};

type PublicRequest = Awaited<ReturnType<CreationService['get']>>;

/** Public view of a creation request. The stored token hash is never exposed. */
export function present(request: PublicRequest, quote?: (quantity: number) => unknown) {
  const children = request.children ?? [];
  const selected = children.filter(child => child.status !== 'SKIPPED');
  return {
    id: request.id, status: request.status, question: request.question, requesterKind: request.requesterKind,
    requester: request.requester, draft: request.draft, draftHash: request.draftHash,
    // A standalone request carries `kind: 'SINGLE'` and no children, exactly as it always behaved.
    kind: request.kind,
    children: children.map(child => ({
      position: child.position, outcomeLabel: child.outcomeLabel, draft: child.draft, draftHash: child.draftHash,
      status: child.status, marketAddress: child.marketAddress, creationTxHash: child.creationTxHash,
      failureCode: child.failureCode, failureDetail: child.failureDetail, attempts: child.attempts, notes: child.notes,
    })),
    event: request.event && {
      id: request.event.id, slug: request.event.slug, title: request.event.title, description: request.event.description,
      category: request.event.category, tags: request.event.tags, exclusivity: request.event.exclusivity,
      exclusivityNote: request.event.exclusivityNote, outcomesComplete: request.event.outcomesComplete,
      status: request.event.status,
      exclusivityEnforcement: request.event.exclusivity === 'EXCLUSIVE' ? 'backend_only' : 'none',
      source: { provider: request.event.sourceProvider, eventId: request.event.sourceEventId,
        slug: request.event.sourceSlug, url: request.event.sourceUrl, importedAt: request.event.importedAt },
      members: request.event.members?.map(member => ({
        position: member.position, outcomeLabel: member.outcomeLabel, question: member.question,
        marketAddress: member.marketAddress, sourceUrl: member.sourceUrl,
      })) ?? [],
    },
    // The explicit group price, shown before approval and bound into the approval hash.
    groupQuote: request.kind === 'GROUP' && quote ? quote(selected.length) : undefined,
    draftProvider: request.draftProvider, draftMode: request.draftMode, review: request.duplicates,
    approvedAt: request.approvedAt, approvedHash: request.approvedHash,
    discountBps: request.discountBps, discountNote: request.discountNote, priceUnits: request.priceUnits,
    marketAddress: request.marketAddress, creationTxHash: request.creationTxHash,
    // A group failure names how many children failed and how many exist; the detail is what makes
    // partial recovery legible, and it is written by this service, never by a source.
    failureCode: request.failureCode, failureDetail: request.failureDetail, attempts: request.attempts,
    createdAt: request.createdAt, updatedAt: request.updatedAt,
    verification: request.verification && { credentialType: request.verification.credentialType, verifier: request.verification.verifier, verifiedAt: request.verification.verifiedAt },
    payment: request.payment && {
      status: request.payment.status, network: request.payment.network, asset: request.payment.asset,
      amountUnits: request.payment.amountUnits, payTo: request.payment.payTo, facilitator: request.payment.facilitator,
      transactionRef: request.payment.transactionRef, payer: request.payment.payer, settledAt: request.payment.settledAt,
      failureCode: request.payment.failureCode, attempts: request.payment.attempts,
    },
    // Creator notices, newest first: "your market was created", with where to find it.
    notifications: (request.notifications ?? []).map(notification => ({
      id: notification.id, kind: notification.kind, title: notification.title, body: notification.body, href: notification.href,
      marketAddress: notification.marketAddress, position: notification.position, sources: notification.sources,
      readAt: notification.readAt, createdAt: notification.createdAt, blockNumber: notification.blockNumber,
    })),
    // Trading is free; this charge buys the creation service only.
    fees: { maker: 0, taker: 0, routing: 0, protocol: 0 },
  };
}

/**
 * A requester's own history. Deliberately narrower than `present`: it carries what identifies a
 * request and what became of it, and leaves out the reviewed draft body, the settlement reference
 * and the credential record, none of which a list needs.
 */
export function presentSummary(request: PublicRequest) {
  return {
    id: request.id, question: request.question, status: request.status, requesterKind: request.requesterKind,
    marketAddress: request.marketAddress, priceUnits: request.priceUnits, discountBps: request.discountBps,
    failureCode: request.failureCode, createdAt: request.createdAt, updatedAt: request.updatedAt,
    paymentStatus: request.payment?.status ?? null, asset: request.payment?.asset ?? null,
    // Enough event context to make a history row legible without opening the request.
    kind: request.kind,
    event: request.event && { slug: request.event.slug, title: request.event.title, status: request.event.status,
      exclusivity: request.event.exclusivity, sourceProvider: request.event.sourceProvider },
    children: (request.children ?? []).filter(child => child.status !== 'SKIPPED').length,
    childrenCreated: (request.children ?? []).filter(child => child.status === 'CREATED').length,
  };
}

export function creationRoutes(service?: CreationService) {
  const router = Router();
  if (!service) {
    router.use((_req, res) => res.status(503).json({ error: 'creation_not_configured' }));
    return router;
  }
  // The audit block travels with the request it belongs to, so every screen that can already
  // read a request can show its published trail without a second authorization path.
  const view = (request: PublicRequest) => ({
    ...present(request, quantity => service.groupQuote(quantity)),
    audit: service.presentAudit(request.auditEvents ?? []),
  });
  const drafting = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
  // A preview reaches an external API, so it gets its own, tighter budget than the other steps.
  const previews = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  const steps = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const fail = (res: Parameters<Parameters<Router['post']>[1]>[1], error: unknown) => {
    if (error instanceof WorkflowError) { res.status(error.httpStatus).json({ error: error.code }); return; }
    // An import failure is about the source address or the source itself, and the requester needs
    // the reason to fix it. The codes are fixed strings from the importer, never source content.
    if (error instanceof ImportError) { res.status(error.httpStatus).json({ error: error.code }); return; }
    console.error('Creation request failed; internal details withheld');
    res.status(500).json({ error: 'internal_error' });
  };
  const key = (req: Request, fallback: string | undefined) => {
    const supplied = req.get('idempotency-key')?.trim() || fallback;
    return supplied && supplied.length >= 8 && supplied.length <= 128 ? supplied : undefined;
  };

  router.post('/requests', drafting, async (req, res) => {
    const input = draftRequestSchema.safeParse(req.body);
    const idempotencyKey = key(req, input.data?.idempotencyKey);
    if (!input.success || !idempotencyKey) {
      res.status(400).json({ error: 'invalid_creation_request' });
      return;
    }
    try {
      const result = await service.createDraft({ ...input.data, idempotencyKey });
      res.status(result.replay ? 200 : 201).json(serialize({ request: view(result.request), accessToken: result.token, replay: result.replay }));
    } catch (error) { fail(res, error); }
  });

  /**
   * A manually authored event: one request, several binary children, one payment. A single-market
   * request still goes to POST /requests and behaves exactly as it always has.
   */
  router.post('/groups', drafting, async (req, res) => {
    const input = groupSchema.safeParse(req.body);
    const idempotencyKey = key(req, input.data?.idempotencyKey);
    if (!input.success || !idempotencyKey) { res.status(400).json({ error: 'invalid_group_request' }); return; }
    try {
      const result = await service.createGroup({ ...input.data, idempotencyKey });
      res.status(result.replay ? 200 : 201).json(serialize({ request: view(result.request), accessToken: result.token, replay: result.replay }));
    } catch (error) { fail(res, error); }
  });

  /**
   * Reads one Polymarket page address and reports exactly what Horizon would create from it.
   * Nothing is written, nothing is charged and no contract is touched. The address is parsed and
   * only its slug reaches the fixed Polymarket API origin, so no arbitrary URL is ever fetched.
   */
  router.post('/imports/preview', previews, async (req, res) => {
    const input = previewSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'import_url_invalid' }); return; }
    try { res.json(serialize(await service.previewImport(input.data.url))); }
    catch (error) { fail(res, error); }
  });

  /** Creates the event, the request and its children from a source page. Idempotent per key. */
  router.post('/imports', drafting, async (req, res) => {
    const input = importSchema.safeParse(req.body);
    const idempotencyKey = key(req, input.data?.idempotencyKey);
    if (!input.success || !idempotencyKey) { res.status(400).json({ error: 'invalid_import_request' }); return; }
    try {
      const result = await service.createImport({ ...input.data, idempotencyKey });
      if (!result.ok) {
        // Not an error the requester made: the source cannot be imported, or already was. Both
        // answers carry the reasons and the links, so nobody pays for a duplicate.
        res.status(result.reason === 'import_not_supported' ? 422 : 409)
          .json(serialize({ error: result.reason, preview: result.preview, existing: result.existing, source: result.source }));
        return;
      }
      res.status(result.replay ? 200 : 201).json(serialize({ request: view(result.request), accessToken: result.token, replay: result.replay }));
    } catch (error) { fail(res, error); }
  });

  /** Requests made by one requester. `/requests/:id` still needs the bearer token, this does not. */
  router.get('/requests', steps, async (req, res) => {
    const requester = z.string().trim().min(3).max(128).safeParse(req.query.requester);
    if (!requester.success) { res.status(400).json({ error: 'invalid_requester' }); return; }
    try { res.json(serialize({ requests: (await service.listByRequester(requester.data)).map(presentSummary) })); }
    catch (error) { fail(res, error); }
  });

  router.get('/requests/:id', steps, async (req, res) => {
    try { res.json(serialize({ request: view(await service.get(req.params.id!, bearer(req))) })); }
    catch (error) { fail(res, error); }
  });

  /** Chooses which children of a group are created. Refused after approval; it rewrites the plan. */
  router.post('/requests/:id/selection', steps, async (req, res) => {
    const input = selectionSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_selection' }); return; }
    try { res.json(serialize({ request: view(await service.selectChildren(req.params.id!, bearer(req), input.data.positions)) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/approval', steps, async (req, res) => {
    const input = approvalSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_approval' }); return; }
    try { res.json(serialize({ request: view(await service.approve(req.params.id!, bearer(req), input.data.draftHash)) })); }
    catch (error) { fail(res, error); }
  });

  /**
   * The published audit trail of one request. `?verify=1` reads each confirmed statement back
   * from the mirror node and compares it with what this service holds, which is the check a
   * third party can repeat against the same public URLs without trusting this API.
   */
  router.get('/requests/:id/audit', steps, async (req, res) => {
    try { res.json(serialize({ audit: await service.auditTrail(req.params.id!, bearer(req), req.query.verify === '1') })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/notifications/:notificationId/read', steps, async (req, res) => {
    const notificationId = z.string().uuid().safeParse(req.params.notificationId);
    if (!notificationId.success) { res.status(400).json({ error: 'invalid_notification' }); return; }
    try { res.json(serialize({ request: view(await service.markNotificationRead(req.params.id!, bearer(req), notificationId.data)) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/abandonment', steps, async (req, res) => {
    try { res.json(serialize({ request: view(await service.abandon(req.params.id!, bearer(req))) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/verification', steps, async (req, res) => {
    const input = verificationSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'invalid_proof' }); return; }
    try { res.json(serialize({ request: view(await service.verify(req.params.id!, bearer(req), input.data.proof)) })); }
    catch (error) { fail(res, error); }
  });

  router.post('/requests/:id/world/rp-context', steps, async (req, res) => {
    try { res.json(await service.worldContext(req.params.id!, bearer(req))); }
    catch (error) { fail(res, error); }
  });

  /**
   * One x402 resource. Without a payment header it answers 402 with the requirements for this
   * exact request; with one it verifies and settles. Both browser and agent clients use it.
   */
  router.post('/requests/:id/payment', steps, async (req, res) => {
    const id = req.params.id!, token = bearer(req);
    const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}/api/creation/requests/${id}/payment`;
    const header = req.get('payment-signature') ?? req.get('x-payment');
    try {
      if (!header) {
        const issued = await service.requirePayment(id, token, resource);
        if (issued.payment.status === 'SETTLED') { res.json(serialize({ paid: true, request: view(issued.request) })); return; }
        const request = view(issued.request);
        const children = request.children.filter(child => child.status !== 'SKIPPED').length;
        const description = request.kind === 'GROUP'
          ? `Horizon market creation service: ${children} market${children === 1 ? '' : 's'} in the event "${request.question}". `
            + 'This charge is for creation only; Horizon takes no trading fee.'
          : 'Horizon market creation service. This charge is for creation only; Horizon takes no trading fee.';
        const accepts = [await service.requirements(issued.payment)];
        const x402 = {
          x402Version: 2, error: 'payment_required',
          resource: { url: resource, description, mimeType: 'application/json' as const }, accepts,
        };
        // The header carries the x402 declaration and nothing else. A group request body is far
        // larger than a header may be — the drafts and the import review live in it — and an
        // oversized header is dropped by the client's HTTP parser before anything can read it.
        res.setHeader('payment-required', Buffer.from(JSON.stringify(x402)).toString('base64'));
        res.status(402).json(serialize({ ...x402, request }));
        return;
      }
      const settled = await service.submitPayment(id, token, header, resource);
      if (settled.settlement) {
        const encoded = Buffer.from(JSON.stringify(settled.settlement)).toString('base64');
        res.setHeader('payment-response', encoded);
        res.setHeader('x-payment-response', encoded);
      }
      res.json(serialize({ paid: true, replay: settled.replay, request: view(settled.request) }));
    } catch (error) { fail(res, error); }
  });

  return router;
}
