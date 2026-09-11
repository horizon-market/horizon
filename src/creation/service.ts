import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ImportsConfig, PaymentsConfig, WorldConfig } from '../config.js';
import { creationPrice, groupPrice, utcDay } from './pricing.js';
import {
  draftHash, draftSchema, DraftError, eventDraftSchema, groupPlanHash, provenanceSchema,
  type ChildPlan, type EventDraft, type GroupPlan, type MarketContext, type MarketDraft, type MarketDraftProvider, type Provenance,
} from './types.js';
import { GammaClient, ImportError, parsePolymarketUrl } from '../imports/polymarket.js';
import { normalizeEvent, outcomesComplete, slugify, snapshotMarket, type NormalizedEvent } from '../imports/normalize.js';
import { buildRequirements, decodePayment, paymentMatches, paymentNonce, payloadFingerprint, PaymentPayloadError, PaymentRejectedError, SettlementAmbiguousError, type PaymentFacilitator } from '../payments/x402.js';
import { createRpContext, proofSchema, VerificationRejectedError, VerificationUnavailableError, type HumanVerifier, type VerificationProof } from '../world/verifier.js';
import { creationId, type MarketDeployer } from './onchain.js';
import type { AuditService } from '../audit/service.js';
import { draftApproved, marketCreated, paymentSettled } from '../audit/events.js';
import { recordLiveEvents } from '../live/messages.js';
import { creationMessage, presentNotification, upsertCreatedNotification, upsertEventCreatedNotification } from '../live/notifications.js';

export const STATUSES = ['DRAFT', 'APPROVED', 'PAYMENT_REQUIRED', 'PAYMENT_REVIEW', 'PAID', 'CREATING', 'CREATED', 'FAILED', 'ABANDONED'] as const;
export type Status = typeof STATUSES[number];
export type Event = 'approve' | 'require_payment' | 'settle' | 'review' | 'start_creation' | 'created' | 'fail' | 'retry' | 'abandon';

/** The workflow only moves along declared edges, so no step can be skipped by an API caller. */
export const TRANSITIONS: Record<Status, Partial<Record<Event, Status>>> = {
  DRAFT: { approve: 'APPROVED', abandon: 'ABANDONED' },
  APPROVED: { require_payment: 'PAYMENT_REQUIRED', abandon: 'ABANDONED' },
  PAYMENT_REQUIRED: { settle: 'PAID', review: 'PAYMENT_REVIEW', abandon: 'ABANDONED' },
  PAYMENT_REVIEW: { settle: 'PAID' },
  PAID: { start_creation: 'CREATING' },
  // `retry` re-enters CREATING so an interrupted run is resumable. A run that dies with the
  // process — a restarted worker, a killed container — leaves the request here with no code
  // left to record a failure, and without this edge every later attempt would be refused and
  // the paid request stranded. Re-entry is safe: the registry is checked for each creation id
  // before anything is broadcast, so nothing is deployed or charged twice.
  CREATING: { created: 'CREATED', fail: 'FAILED', retry: 'CREATING' },
  FAILED: { retry: 'CREATING' },
  CREATED: {},
  // A requester walks away from their own request, and only before money moves: `abandon` exists on
  // no status where a payment has settled or is in flight, so nothing paid for can be discarded.
  ABANDONED: {},
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
  imports?: ImportsConfig;
  /** Injectable so the import path is testable without reaching Polymarket. */
  gamma?: GammaClient;
  /**
   * The public audit trail. Statements are written to its outbox inside the same transaction as
   * the transition they record, and published asynchronously, so nothing on this path waits for
   * Hedera and nothing on it can be repeated because Hedera was unavailable.
   */
  audit?: AuditService;
  /** The EVM chain a created market is deployed to; published with the market reference. */
  chainId?: number;
};

export type Requester = { requesterKind: 'browser' | 'agent'; requester: string };
export type CreateDraftInput = { idempotencyKey: string; question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string };
/** A manually authored group: one event, and the binary question of each child. */
export type CreateGroupInput = Requester & {
  idempotencyKey: string;
  event: { title: string; description?: string; category?: string; exclusivity: 'COLLECTION' | 'EXCLUSIVE'; outcomesComplete?: boolean };
  children: { question: string; outcomeLabel: string; closeAt?: string }[];
};
export type ImportInput = Requester & { idempotencyKey: string; url: string; positions?: number[] };

const REQUEST_INCLUDE = {
  payment: true, verification: true,
  children: { orderBy: { position: 'asc' } },
  event: { include: { members: { orderBy: { position: 'asc' } } } },
  notifications: { orderBy: { createdAt: 'desc' } },
  // The public audit trail of this request, in publication order.
  auditEvents: { orderBy: { sequence: 'asc' } },
} as const;

const hashToken = (token: string) => createHash('sha256').update(token).digest();

type ChildRow = { id: string; position: number; outcomeLabel: string; draft: Prisma.JsonValue; status: string };

export class CreationService {
  constructor(private deps: CreationDependencies) {}

  private bounds() { return this.deps.closeBounds ?? { minSeconds: 3600, maxSeconds: 365 * 24 * 3600 }; }

  private authorize(request: { accessTokenHash: string }, token: string | undefined) {
    const expected = Buffer.from(request.accessTokenHash, 'hex');
    if (!token || expected.length !== 32) throw new WorkflowError('unauthorized', 401);
    const actual = hashToken(token);
    if (!timingSafeEqual(actual, expected)) throw new WorkflowError('unauthorized', 401);
  }

  /**
   * Which of these requests the caller holds the token for, for a subscription that names several.
   * The ones that fail are dropped without a word: an answer that named them would tell a caller
   * which ids exist, which is more than a wrong token should learn.
   */
  async authorized(claims: { id: string; token: string }[]): Promise<string[]> {
    if (claims.length === 0) return [];
    const rows = await this.deps.db.creationRequest.findMany({ where: { id: { in: claims.map(claim => claim.id) } }, select: { id: true, accessTokenHash: true } });
    const byId = new Map(rows.map(row => [row.id, row]));
    const granted: string[] = [];
    for (const claim of claims) {
      const row = byId.get(claim.id);
      if (!row) continue;
      try { this.authorize(row, claim.token); granted.push(claim.id); } catch { /* not this caller's request */ }
    }
    return granted;
  }

  /** A notice is the requester's to dismiss; the same token that reads the request marks it. */
  async markNotificationRead(id: string, token: string | undefined, notificationId: string) {
    await this.load(id, token);
    const updated = await this.deps.db.notification.updateMany({ where: { id: notificationId, requestId: id, readAt: null }, data: { readAt: new Date() } });
    if (updated.count === 0) {
      const exists = await this.deps.db.notification.findFirst({ where: { id: notificationId, requestId: id }, select: { id: true } });
      if (!exists) throw new WorkflowError('unknown_notification', 404);
    }
    return this.load(id, token);
  }

  private async load(id: string, token: string | undefined) {
    const request = await this.deps.db.creationRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
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

  /**
   * Rebuilds the approval plan for a group request from stored rows. Nothing here is taken from
   * the caller: the event metadata, the children, the selection and the price are all read back,
   * so a client cannot approve a plan the server does not itself hold.
   */
  private groupPlan(request: { draft: Prisma.JsonValue; children: ChildRow[]; event: { sourceProvider: string; sourceEventId: string | null; sourceSlug: string | null; sourceUrl: string | null; importedAt: Date | null } | null }): GroupPlan {
    const event = eventDraftSchema.parse(request.draft);
    const children: ChildPlan[] = [...request.children].sort((a, b) => a.position - b.position).map(child => ({
      position: child.position, outcomeLabel: child.outcomeLabel,
      draft: draftSchema.parse(child.draft), selected: child.status !== 'SKIPPED',
    }));
    const quantity = children.filter(child => child.selected).length;
    const baseUnits = this.deps.payments.priceUnits;
    const source = request.event;
    const provenance: Provenance | undefined = source && source.sourceProvider !== 'horizon' && source.importedAt
      ? provenanceSchema.parse({
        provider: source.sourceProvider, eventId: source.sourceEventId ?? '', eventSlug: source.sourceSlug ?? '',
        url: source.sourceUrl ?? '', importedAt: source.importedAt.toISOString(),
      })
      : undefined;
    return { event, children, pricing: { baseUnits, quantity, totalUnits: baseUnits * BigInt(quantity) }, provenance };
  }

  /**
   * The hash a request is approved against. A standalone request binds to its single draft, exactly
   * as it did before events existed; a group binds to its whole plan.
   */
  private planHash(request: { kind: string; draft: Prisma.JsonValue; draftHash: string | null; children: ChildRow[]; event: Parameters<CreationService['groupPlan']>[0]['event'] }): string {
    if (request.kind !== 'GROUP') return request.draftHash ?? '';
    return groupPlanHash(this.groupPlan(request));
  }

  /** The price a group shows before approval, and the price its plan hash is bound to. */
  groupQuote(quantity: number) {
    const price = groupPrice(this.deps.payments.priceUnits, Math.max(1, quantity), this.deps.payments.discountBps, false);
    const discounted = groupPrice(this.deps.payments.priceUnits, Math.max(1, quantity), this.deps.payments.discountBps, true);
    return {
      unitUnits: price.unitUnits.toString(), quantity, totalUnits: price.payableUnits.toString(),
      discountedTotalUnits: discounted.payableUnits.toString(), discountBps: this.deps.payments.discountBps,
      asset: this.deps.payments.asset, assetDecimals: this.deps.payments.assetDecimals, network: this.deps.payments.network,
      note: 'One creation charge per market, the same price a standalone market pays. A verified credential discounts the group total once, not once per market.',
    };
  }

  /** Draft creation is idempotent by key: a retried request never produces a second draft. */
  async createDraft(input: CreateDraftInput) {
    const existing = await this.deps.db.creationRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: REQUEST_INCLUDE });
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
      include: REQUEST_INCLUDE,
    });
    return { request: created, token, replay: false };
  }

  // -------------------------------------------------------------------------
  // Events: manually authored groups, and imports.
  //
  // A group request is the same workflow as a standalone one — draft, review,
  // approve, pay, create — with several children behind one payment. What is
  // stored is metadata about markets, never a market: an imported child is not a
  // market until it is deployed on chain and The Graph indexes it.
  // -------------------------------------------------------------------------

  private gamma(): GammaClient {
    const config = this.deps.imports;
    if (!config?.enabled) throw new WorkflowError('imports_not_configured', 503);
    return this.deps.gamma ?? new GammaClient(config.polymarketApiOrigin, undefined, config.timeoutMs);
  }

  private maxChildren() { return this.deps.imports?.maxChildren ?? 24; }

  /** A stable, readable address for the event page. Collisions get a short suffix. */
  private async uniqueSlug(base: string): Promise<string> {
    const root = slugify(base);
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = attempt === 0 ? root : `${root}-${randomBytes(3).toString('hex')}`;
      if (!await this.deps.db.marketEvent.findUnique({ where: { slug: candidate }, select: { id: true } })) return candidate;
    }
    return `${root}-${randomBytes(6).toString('hex')}`;
  }

  private async existingImport(provider: string, sourceEventId: string) {
    return this.deps.db.marketEvent.findUnique({
      where: { sourceProvider_sourceEventId: { sourceProvider: provider, sourceEventId } },
      include: { members: { orderBy: { position: 'asc' } }, requests: { orderBy: { createdAt: 'desc' }, take: 5 } },
    });
  }

  /**
   * What a previously imported source event became on Horizon. Shown before anything is charged,
   * so a duplicate import is answered with links to the existing markets rather than a second bill.
   */
  private describeExisting(event: Awaited<ReturnType<CreationService['existingImport']>>) {
    if (!event) return undefined;
    const live = event.requests.filter(request => request.status !== 'ABANDONED');
    return {
      eventId: event.id, slug: event.slug, title: event.title, status: event.status,
      importedAt: event.importedAt, sourceUrl: event.sourceUrl,
      markets: event.members.map(member => ({ position: member.position, outcomeLabel: member.outcomeLabel,
        question: member.question, marketAddress: member.marketAddress, sourceSlug: member.sourceSlug })),
      created: event.members.filter(member => member.marketAddress).length,
      requests: live.map(request => ({ id: request.id, status: request.status, createdAt: request.createdAt })),
      inProgress: live.some(request => !['CREATED', 'FAILED'].includes(request.status)),
    };
  }

  /**
   * Reads one Polymarket page address and reports exactly what Horizon would create from it.
   * No row is written, nothing is charged, and no contract is touched: this is the review step.
   */
  async previewImport(url: string) {
    const reference = parsePolymarketUrl(url);
    const { event, focusMarketSlug } = await this.gamma().resolve(reference);
    const preview = normalizeEvent(event, {
      bounds: this.bounds(), focusMarketSlug, maxChildren: this.maxChildren(),
    });
    const existing = this.describeExisting(await this.existingImport(preview.source.provider, preview.source.eventId));
    const selected = new Set(preview.children.filter(child => child.preselected).map(child => child.position));
    return {
      source: reference, preview, existing,
      quote: this.groupQuote(selected.size),
      // Polymarket's own prices, liquidity, volume and settlement are not imported and never
      // appear as Horizon data. Only the definition crosses the boundary.
      importPolicy: 'definitions_only',
    };
  }

  private assertSelectable(preview: NormalizedEvent, positions: number[] | undefined) {
    const supported = preview.children.filter(child => child.supported);
    const chosen = positions === undefined
      ? preview.children.filter(child => child.preselected).map(child => child.position)
      : [...new Set(positions)];
    if (chosen.length === 0) throw new WorkflowError('import_selection_empty', 422);
    for (const position of chosen) {
      if (!supported.some(child => child.position === position)) throw new WorkflowError('import_selection_unsupported', 422);
    }
    return new Set(chosen);
  }

  /**
   * Creates the durable event, the creation request and its children from one source page.
   *
   * Idempotency has two locks. The request's own key answers a retried call with the same request,
   * as it always has. The unique (sourceProvider, sourceEventId) on the event answers a *different*
   * caller importing the same source: the second one is told what already exists and is never given
   * a second request to pay for.
   */
  async createImport(input: ImportInput) {
    const replayed = await this.deps.db.creationRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: REQUEST_INCLUDE });
    if (replayed) return { ok: true as const, request: replayed, token: undefined, replay: true };
    const { source, preview, existing } = await this.previewImport(input.url);
    if (existing && (existing.inProgress || existing.created > 0)) {
      return { ok: false as const, reason: existing.created > 0 ? 'already_imported' : 'import_in_progress', preview, existing, source };
    }
    if (preview.warnings.some(warning => warning.severity === 'blocking')) {
      return { ok: false as const, reason: 'import_not_supported', preview, existing, source };
    }
    const selected = this.assertSelectable(preview, input.positions);
    const complete = outcomesComplete(preview, selected);
    const eventDraft = eventDraftSchema.parse({
      title: preview.title, description: preview.description, category: preview.category, tags: preview.tags,
      imageUrl: preview.imageUrl, iconUrl: preview.iconUrl,
      exclusivity: preview.exclusivity, exclusivityNote: preview.exclusivityNote, outcomesComplete: complete,
    });
    const supported = preview.children.filter(child => child.supported);
    const token = randomBytes(32).toString('hex');
    const slug = await this.uniqueSlug(preview.title);
    const importedAt = new Date();
    const review = {
      duplicateCheck: 'source_import', groundedOnBlock: -1,
      rationale: `Imported from ${source.url}. Definitions only: the source's prices, liquidity, volume and settlement state are not imported and never appear as Horizon data.`,
      warnings: [],
      import: {
        provider: preview.source.provider, url: source.url, kind: source.kind,
        eventId: preview.source.eventId, eventSlug: preview.source.slug,
        importedAt: importedAt.toISOString(),
        eventWarnings: preview.warnings,
        children: preview.children.map(child => ({
          position: child.position, outcomeLabel: child.outcomeLabel, question: child.question,
          supported: child.supported, selected: selected.has(child.position),
          warnings: child.warnings, ruleChanges: child.ruleChanges, dates: child.dates,
          outcomeMapping: child.outcomeMapping ?? null,
          source: { marketId: child.source.marketId, slug: child.source.slug, url: child.source.url,
            conditionId: child.source.conditionId, outcomes: child.source.outcomes,
            resolutionSource: child.source.resolutionSource, closed: child.source.closed },
        })),
        // Preserved verbatim so a later reader can compare Horizon's wording against the source's.
        sourceRules: preview.children.map(child => ({ position: child.position, description: child.source.description })),
      },
    };

    let created;
    try {
      created = await this.deps.db.$transaction(async tx => {
        const event = await tx.marketEvent.create({
          data: {
            slug, title: eventDraft.title, description: eventDraft.description, category: eventDraft.category,
            tags: eventDraft.tags as unknown as Prisma.InputJsonValue,
            imageUrl: eventDraft.imageUrl || null, iconUrl: eventDraft.iconUrl || null,
            exclusivity: eventDraft.exclusivity, exclusivityNote: eventDraft.exclusivityNote,
            outcomesComplete: complete, status: 'DRAFT', createdBy: input.requester,
            sourceProvider: preview.source.provider, sourceEventId: preview.source.eventId,
            sourceSlug: preview.source.slug, sourceUrl: source.url, importedAt,
            sourceSnapshot: preview.snapshot as unknown as Prisma.InputJsonValue,
            members: {
              create: supported.map(child => ({
                position: child.position, outcomeLabel: child.outcomeLabel, question: child.question,
                sourceMarketId: child.source.marketId, sourceSlug: child.source.slug, sourceUrl: child.source.url,
                sourceSnapshot: { rules: child.source.description, resolutionSource: child.source.resolutionSource,
                  conditionId: child.source.conditionId, outcomes: child.source.outcomes,
                  outcomeMapping: child.outcomeMapping ?? null, dates: child.dates } as unknown as Prisma.InputJsonValue,
              })),
            },
          },
        });
        const request = await tx.creationRequest.create({
          data: {
            idempotencyKey: input.idempotencyKey, question: eventDraft.title, kind: 'GROUP', eventId: event.id,
            requesterKind: input.requesterKind, requester: input.requester,
            accessTokenHash: hashToken(token).toString('hex'), status: 'DRAFT',
            draft: eventDraft as unknown as Prisma.InputJsonValue,
            draftProvider: `import:${preview.source.provider}`, draftMode: 'live',
            duplicates: review as unknown as Prisma.InputJsonValue,
            children: {
              create: supported.map(child => ({
                position: child.position, outcomeLabel: child.outcomeLabel,
                draft: child.draft as unknown as Prisma.InputJsonValue, draftHash: draftHash(child.draft!),
                status: selected.has(child.position) ? 'PENDING' : 'SKIPPED',
                notes: { warnings: child.warnings, ruleChanges: child.ruleChanges } as unknown as Prisma.InputJsonValue,
              })),
            },
          },
          include: REQUEST_INCLUDE,
        });
        return tx.creationRequest.update({
          where: { id: request.id },
          data: { draftHash: this.planHash(request) },
          include: REQUEST_INCLUDE,
        });
      });
    } catch (error) {
      // Two callers raced for the same source event; the loser reports what the winner made.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = this.describeExisting(await this.existingImport(preview.source.provider, preview.source.eventId));
        return { ok: false as const, reason: 'import_in_progress', preview, existing: raced, source };
      }
      throw error;
    }
    return { ok: true as const, request: created, token, replay: false };
  }

  /**
   * A manually authored group. Each child is drafted through the same provider a standalone market
   * uses, so the rules, evidence source and close time a reviewer sees are produced the same way.
   */
  async createGroup(input: CreateGroupInput) {
    const existing = await this.deps.db.creationRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: REQUEST_INCLUDE });
    if (existing) return { request: existing, token: undefined, replay: true };
    if (input.children.length < 1 || input.children.length > this.maxChildren()) throw new WorkflowError('group_child_count_out_of_range', 422);
    const { available, context } = await this.deps.context();
    const drafted: { position: number; outcomeLabel: string; draft: MarketDraft; rationale: string; duplicates: unknown }[] = [];
    for (const [position, child] of input.children.entries()) {
      let result;
      try {
        result = await this.deps.provider.draft({
          question: child.question, category: input.event.category, closeAt: child.closeAt, requesterKind: input.requesterKind,
        }, context);
      } catch (error) { throw new WorkflowError(error instanceof DraftError ? error.message : 'draft_failed', 502); }
      this.validateCloseAt(result.draft);
      drafted.push({ position, outcomeLabel: child.outcomeLabel.trim().slice(0, 80) || result.draft.question.slice(0, 80), draft: result.draft, rationale: result.rationale, duplicates: result.duplicates });
    }
    const eventDraft = eventDraftSchema.parse({
      title: input.event.title, description: input.event.description ?? '',
      category: input.event.category?.trim() || drafted[0]!.draft.category,
      tags: [], imageUrl: '', iconUrl: '',
      exclusivity: input.event.exclusivity,
      exclusivityNote: input.event.exclusivity === 'EXCLUSIVE'
        ? 'The author states that exactly one of these markets resolves YES. Horizon checks proposed resolutions against already resolved siblings; the market contracts themselves know nothing about the group, and each child holds its own collateral.'
        : 'These markets are grouped for context only. Nothing here says one of them must win, and their prices need not add up to 100%.',
      outcomesComplete: input.event.outcomesComplete ?? false,
    });
    const token = randomBytes(32).toString('hex');
    const slug = await this.uniqueSlug(eventDraft.title);
    const created = await this.deps.db.$transaction(async tx => {
      const event = await tx.marketEvent.create({
        data: {
          slug, title: eventDraft.title, description: eventDraft.description, category: eventDraft.category,
          tags: eventDraft.tags as unknown as Prisma.InputJsonValue, exclusivity: eventDraft.exclusivity,
          exclusivityNote: eventDraft.exclusivityNote, outcomesComplete: eventDraft.outcomesComplete,
          status: 'DRAFT', createdBy: input.requester, sourceProvider: 'horizon',
          members: { create: drafted.map(child => ({ position: child.position, outcomeLabel: child.outcomeLabel, question: child.draft.question })) },
        },
      });
      const request = await tx.creationRequest.create({
        data: {
          idempotencyKey: input.idempotencyKey, question: eventDraft.title, kind: 'GROUP', eventId: event.id,
          requesterKind: input.requesterKind, requester: input.requester,
          accessTokenHash: hashToken(token).toString('hex'), status: 'DRAFT',
          draft: eventDraft as unknown as Prisma.InputJsonValue,
          draftProvider: this.deps.provider.name, draftMode: this.deps.provider.mode,
          duplicates: {
            duplicateCheck: available ? 'live_graph' : 'unavailable_not_configured', groundedOnBlock: context.indexedBlock,
            rationale: drafted[0]!.rationale,
            warnings: drafted.flatMap(child => child.duplicates as unknown[]),
          } as unknown as Prisma.InputJsonValue,
          children: {
            create: drafted.map(child => ({
              position: child.position, outcomeLabel: child.outcomeLabel,
              draft: child.draft as unknown as Prisma.InputJsonValue, draftHash: draftHash(child.draft), status: 'PENDING',
            })),
          },
        },
        include: REQUEST_INCLUDE,
      });
      return tx.creationRequest.update({ where: { id: request.id }, data: { draftHash: this.planHash(request) }, include: REQUEST_INCLUDE });
    });
    return { request: created, token, replay: false };
  }

  /**
   * Chooses which children of a group are created. Only available before approval, and it always
   * rewrites the plan hash: changing the selection changes both the outcome set and the price, so
   * any approval taken against the old plan is worthless afterwards.
   */
  async selectChildren(id: string, token: string | undefined, positions: number[]) {
    const request = await this.load(id, token);
    if (request.kind !== 'GROUP') throw new WorkflowError('selection_not_available_for_single_request', 409);
    if (request.status !== 'DRAFT') throw new WorkflowError('selection_after_approval', 409);
    const wanted = new Set(positions);
    if (wanted.size === 0) throw new WorkflowError('import_selection_empty', 422);
    const known = new Set(request.children.map(child => child.position));
    for (const position of wanted) if (!known.has(position)) throw new WorkflowError('import_selection_unsupported', 422);
    return this.deps.db.$transaction(async tx => {
      for (const child of request.children) {
        const status = wanted.has(child.position) ? 'PENDING' : 'SKIPPED';
        if (child.status !== status) await tx.creationChild.update({ where: { id: child.id }, data: { status } });
      }
      const reloaded = await tx.creationRequest.findUniqueOrThrow({ where: { id }, include: REQUEST_INCLUDE });
      // A partial selection is never presented as an exhaustive outcome set.
      const draft = eventDraftSchema.parse(reloaded.draft);
      const complete = draft.outcomesComplete && reloaded.children.every(child => child.status !== 'SKIPPED');
      const updatedDraft: EventDraft = { ...draft, outcomesComplete: complete };
      const withDraft = { ...reloaded, draft: updatedDraft as unknown as Prisma.JsonValue };
      // The durable event carries the same claim, so no screen reading the event row can call a
      // narrowed selection exhaustive either.
      if (reloaded.eventId) await tx.marketEvent.update({ where: { id: reloaded.eventId }, data: { outcomesComplete: complete } });
      return tx.creationRequest.update({
        where: { id },
        data: { draft: updatedDraft as unknown as Prisma.InputJsonValue, draftHash: this.planHash(withDraft) },
        include: REQUEST_INCLUDE,
      });
    });
  }

  async get(id: string, token: string | undefined) { return this.load(id, token); }

  /**
   * The public audit trail of one request, optionally read back from the mirror node.
   *
   * Authorization is the request's own bearer token, unchanged: the trail says nothing a
   * requester cannot already see on their request, and it discloses no field that `present`
   * does not already return.
   */
  async auditTrail(id: string, token: string | undefined, verify = false) {
    const request = await this.load(id, token);
    if (!this.deps.audit) throw new WorkflowError('audit_not_configured', 503);
    const events = request.auditEvents ?? [];
    const view = this.deps.audit.present(events);
    return verify ? { ...view, verification: await this.deps.audit.verify(events) } : view;
  }

  /** The trail as it is embedded in every request view. */
  presentAudit(events: Parameters<AuditService['present']>[0]) {
    return this.deps.audit?.present(events);
  }

  /**
   * The requester walks away from their own request, which is what frees them to draft another.
   * `transition` is the gate: `abandon` is declared on no status where a payment has settled or is
   * in flight, so a paid request can never be discarded and its money can never be stranded. The
   * row is kept rather than deleted — the requester's own history should show what they abandoned.
   */
  async abandon(id: string, token: string | undefined) {
    const request = await this.load(id, token);
    if (request.status === 'ABANDONED') return request;
    const status = transition(request.status as Status, 'abandon');
    const payment = request.payment;
    // An intent that was already claimed by a submission is settling somewhere; leave it alone.
    if (payment && !['REQUIRED', 'FAILED'].includes(payment.status)) throw new WorkflowError('payment_in_progress_reconcile');
    return this.deps.db.$transaction(async tx => {
      if (payment) {
        await tx.paymentIntent.update({ where: { id: payment.id, status: payment.status }, data: { status: 'CANCELLED', failureCode: 'request_abandoned' } });
      }
      const updated = await tx.creationRequest.update({ where: { id, status: request.status }, data: { status }, include: REQUEST_INCLUDE });
      // A discarded group leaves no half-made event behind, and — for an import — releases the
      // source event so the same page can be imported again rather than being locked out forever.
      if (request.eventId) {
        const event = await tx.marketEvent.findUnique({
          where: { id: request.eventId },
          include: { members: { select: { marketAddress: true } }, requests: { select: { id: true, status: true } } },
        });
        const orphaned = event && event.status === 'DRAFT'
          && !event.members.some(member => member.marketAddress)
          && event.requests.every(other => other.id === id || other.status === 'ABANDONED');
        if (orphaned) await tx.marketEvent.delete({ where: { id: event.id } });
      }
      return updated;
    });
  }

  /**
   * Every request one requester has made, newest first. Read-only and identity-scoped the way
   * `/api/positions/:account` and `/api/curves/:account` are; the per-request bearer token still
   * gates every action, so listing a request never confers the ability to move it along.
   */
  async listByRequester(requester: string, take = 50) {
    return this.deps.db.creationRequest.findMany({
      where: { requester }, orderBy: { createdAt: 'desc' }, take, include: REQUEST_INCLUDE,
    });
  }

  async worldContext(id: string, token: string | undefined) {
    const request = await this.load(id, token);
    if (request.status !== 'APPROVED') throw new WorkflowError('verification_not_available_for_status', 409);
    try { return createRpContext(this.deps.world); }
    catch { throw new WorkflowError('verification_unavailable', 503); }
  }

  /**
   * A human approves the exact reviewed draft; a changed draft invalidates the approval hash.
   *
   * For a group the hash covers the whole plan — event metadata, the selected children's drafts,
   * their labels and order, the provenance and the price shown — and it is recomputed here from
   * stored rows rather than trusted, so a plan that moved between review and approval is refused.
   */
  async approve(id: string, token: string | undefined, approvedHash: string) {
    const request = await this.load(id, token);
    if (request.status === 'APPROVED' && request.approvedHash === approvedHash) return request;
    const status = transition(request.status as Status, 'approve');
    const current = this.planHash(request);
    if (!current || current !== approvedHash || request.draftHash !== current) throw new WorkflowError('draft_hash_mismatch', 422);
    if (request.kind === 'GROUP') {
      const plan = this.groupPlan(request);
      const selected = plan.children.filter(child => child.selected);
      if (selected.length === 0) throw new WorkflowError('import_selection_empty', 422);
      for (const child of selected) this.validateCloseAt(child.draft);
      // Durable membership now matches what will actually be created; a deselected child is not
      // part of the event, so browsing never lists an outcome nobody can trade.
      const keep = new Set(selected.map(child => child.position));
      const updated = await this.deps.db.$transaction(async tx => {
        if (request.eventId) {
          await tx.eventMarket.deleteMany({ where: { eventId: request.eventId, marketAddress: null, position: { notIn: [...keep] } } });
        }
        const approvedAt = new Date();
        const row = await tx.creationRequest.update({
          where: { id, status: request.status }, data: { status, approvedAt, approvedHash },
          include: REQUEST_INCLUDE,
        });
        await this.deps.audit?.record(tx, draftApproved({ requestId: id, draftHash: approvedHash, occurredAt: approvedAt }));
        return row;
      });
      await this.deps.audit?.notify(id);
      return updated;
    }
    this.validateCloseAt(draftSchema.parse(request.draft));
    const updated = await this.deps.db.$transaction(async tx => {
      const approvedAt = new Date();
      const row = await tx.creationRequest.update({
        where: { id, status: request.status }, data: { status, approvedAt, approvedHash },
        include: REQUEST_INCLUDE,
      });
      // The approval and its public statement commit together: a request cannot be approved
      // without the statement being queued, and the statement cannot exist without the approval.
      await this.deps.audit?.record(tx, draftApproved({ requestId: id, draftHash: approvedHash, occurredAt: approvedAt }));
      return row;
    });
    await this.deps.audit?.notify(id);
    return updated;
  }

  /** Verification is optional. It only affects price after the server confirms the credential. */
  async verify(id: string, token: string | undefined, proof: VerificationProof) {
    const request = await this.load(id, token);
    if (request.status === 'ABANDONED') throw new WorkflowError('request_abandoned', 409);
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
    // Checked before the replay shortcut: an abandoned request keeps its cancelled intent on file.
    if (request.status === 'ABANDONED') throw new WorkflowError('request_abandoned', 409);
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
      // A group is charged per market at the standalone price; the discount applies once, to the
      // whole request, so a credential is worth one discounted request per day and not one per child.
      const quantity = request.kind === 'GROUP' ? request.children.filter(child => child.status !== 'SKIPPED').length : 1;
      if (quantity < 1) throw new WorkflowError('import_selection_empty', 422);
      const price = groupPrice(this.deps.payments.priceUnits, quantity, this.deps.payments.discountBps, eligible);
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
        include: REQUEST_INCLUDE,
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
    if (request.status === 'ABANDONED') throw new WorkflowError('request_abandoned', 409);
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
      const settledAt = new Date();
      const [updatedPayment, updatedRequest] = await this.deps.db.$transaction(async tx => {
        const updated = await tx.paymentIntent.update({
          where: { id: payment.id },
          data: { status: 'SETTLED', transactionRef: settled.transaction, payer: settled.payer, payloadHash: payloadFingerprint(header), settledAt, failureCode: null },
        });
        const row = await tx.creationRequest.update({ where: { id }, data: { status: 'PAID' }, include: REQUEST_INCLUDE });
        // Written only now, with the settlement receipt in hand: no successful-payment statement
        // exists for a payment this service has not recorded as settled.
        //
        // Guarded like the creation statement below. A payment can only be submitted for an
        // approved request, so the hash is always there — but an unpublishable statement must
        // never be the reason a settled Hedera payment is rolled back into reconciliation.
        const approvedHash = request.approvedHash ?? request.draftHash;
        if (approvedHash) {
          await this.deps.audit?.record(tx, paymentSettled({
            requestId: id, draftHash: approvedHash, occurredAt: settledAt,
            network: updated.network, asset: updated.asset, amountUnits: updated.amountUnits,
            transactionRef: settled.transaction,
          }));
        }
        return [updated, row] as const;
      });
      await this.deps.enqueue?.(id).catch(() => undefined);
      await this.deps.audit?.notify(id);
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

  /**
   * Records one MARKET_CREATED statement inside the transaction that marks the market created.
   *
   * A statement is only written when every reference in it exists: the settled payment, the
   * approved draft hash and the deployed address. `transactionHash` may legitimately be null on a
   * resumed run that found the market already in the registry without observing its broadcast;
   * the address and the derived creation id stay checkable on chain in that case.
   */
  private async recordCreation(
    tx: Prisma.TransactionClient,
    request: { id: string; approvedHash: string | null; draftHash: string | null; payment: { transactionRef: string | null } | null },
    market: { address: string; transactionHash: string | null; position?: number },
  ) {
    const transactionRef = request.payment?.transactionRef;
    const draftHashValue = request.approvedHash ?? request.draftHash;
    if (!this.deps.audit || !transactionRef || !draftHashValue) return;
    await this.deps.audit.record(tx, marketCreated({
      requestId: request.id, draftHash: draftHashValue, occurredAt: new Date(), transactionRef,
      chainId: this.deps.chainId ?? 11155111, address: market.address,
      transactionHash: market.transactionHash, position: market.position,
    }));
  }

  /**
   * The creator's notice and the private live message, in the transaction that records CREATED.
   * The stream writes the same notice by the same key when it sees the block; whichever arrives
   * second merges into the first, so a market is announced once however the two paths race.
   */
  private async announceCreation(tx: Prisma.TransactionClient, market: { requestId: string; marketAddress: string; question: string; transactionHash: string | null }) {
    const { notification } = await upsertCreatedNotification(tx, { requestId: market.requestId, marketAddress: market.marketAddress,
      question: market.question, source: 'receipt', txHash: market.transactionHash });
    await recordLiveEvents(tx, [creationMessage(market.requestId, { position: null, marketAddress: market.marketAddress.toLowerCase(),
      status: 'CREATED', notification: presentNotification(notification) })]);
  }

  /**
   * A group's one notice, in the transaction that records the whole request CREATED. Each child
   * still sends the private message as it deploys — the create page follows it market by market —
   * but the creator asked for an event, and is told about the event, once. The stream writes the
   * same notice by the same key when it sees the last child's block.
   */
  private async announceEvent(tx: Prisma.TransactionClient, request: { id: string; event: { slug: string; title: string } }, markets: number) {
    const { notification } = await upsertEventCreatedNotification(tx, { requestId: request.id, slug: request.event.slug, title: request.event.title,
      markets, source: 'receipt', txHash: null });
    await recordLiveEvents(tx, [creationMessage(request.id, { status: 'CREATED', notification: presentNotification(notification) })]);
  }

  /** Runs the paid creation step. Safe to retry: the registry is checked before any broadcast. */
  async runCreation(id: string) {
    const request = await this.deps.db.creationRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!request) throw new WorkflowError('unknown_request', 404);
    if (request.status === 'CREATED') return request;
    if (request.payment?.status !== 'SETTLED') throw new WorkflowError('creation_before_settlement');
    if (!this.deps.deployer) throw new WorkflowError('creation_not_configured', 503);
    // Only a freshly paid request starts creation; CREATING and FAILED resume one. Every other
    // status has neither edge, so an API caller still cannot skip a step.
    const status = transition(request.status as Status, request.status === 'PAID' ? 'start_creation' : 'retry');
    // The registry key is written before anything is broadcast, so the stream can name this
    // request the moment the chain announces its market — even if this process dies first.
    await this.deps.db.creationRequest.update({ where: { id }, data: { status, attempts: { increment: 1 }, failureCode: null, failureDetail: null,
      ...(request.kind === 'SINGLE' ? { creationId: creationId(id) } : {}) } });
    // Everything past the move into CREATING runs inside the catch: a throw that escaped it would
    // leave the request in a state whose failure nothing had recorded.
    try {
      if (request.kind === 'GROUP') return await this.runGroupCreation(request);
      const draft = draftSchema.parse(request.draft);
      if (request.approvedHash !== draftHash(draft)) throw new WorkflowError('draft_not_approved');
      const created = await this.deps.deployer.create({
        requestId: id, question: draft.question, rules: draft.rules, evidenceSource: draft.evidenceSource,
        closeAt: Math.floor(new Date(draft.closeAt).getTime() / 1000),
      });
      // Past this point the deployment receipt is confirmed and the registry names the market,
      // which is the only condition under which a creation statement is written.
      const transactionHash = created.transactionHash ?? request.creationTxHash;
      return await this.deps.db.$transaction(async tx => {
        const row = await tx.creationRequest.update({
          where: { id }, data: { status: 'CREATED', marketAddress: created.market, creationTxHash: transactionHash },
        });
        await this.recordCreation(tx, request, { address: created.market, transactionHash });
        await this.announceCreation(tx, { requestId: id, marketAddress: created.market, question: draft.question, transactionHash });
        return row;
      });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'creation_failed';
      // A group records its own, more precise failure before it throws; this is the catch-all for a
      // run that threw before reaching that point, and it must not overwrite the better message.
      await this.deps.db.creationRequest.updateMany({
        where: { id, status: { not: 'FAILED' } },
        data: { status: 'FAILED', failureCode: 'creation_failed', failureDetail: code },
      });
      throw error;
    } finally {
      // Whatever the outcome, wake the publisher for whatever this run committed. It never
      // throws, so it cannot turn a successful creation into a failed one.
      await this.deps.audit?.notify(id);
    }
  }

  /**
   * Deploys the selected children of one paid group request, in order.
   *
   * Children are independent markets, so one failing does not stop the others: every child is
   * attempted, and the request fails only if some child did. A retry then walks the same list and
   * skips anything already CREATED — and even for a child whose status was lost mid-broadcast, the
   * deployer looks its per-child creation id up in the registry before broadcasting anything. The
   * payment is settled once, for the request; nothing on this path can charge again.
   */
  private async runGroupCreation(request: Awaited<ReturnType<CreationService['load']>>) {
    const id = request.id;
    const plan = this.groupPlan(request);
    if (!request.approvedHash || request.approvedHash !== groupPlanHash(plan)) throw new WorkflowError('draft_not_approved');
    const selected = request.children.filter(child => child.status !== 'SKIPPED').sort((a, b) => a.position - b.position);
    if (selected.length === 0) throw new WorkflowError('import_selection_empty', 422);
    let failed = 0, deployed = 0;
    for (const child of selected) {
      if (child.status === 'CREATED' && child.marketAddress) continue;
      const draft = draftSchema.parse(child.draft);
      await this.deps.db.creationChild.update({
        where: { id: child.id }, data: { status: 'CREATING', attempts: { increment: 1 }, failureCode: null, failureDetail: null, creationId: creationId(id, child.position) },
      });
      try {
        const created = await this.deps.deployer!.create({
          requestId: id, position: child.position, question: draft.question, rules: draft.rules,
          evidenceSource: draft.evidenceSource, closeAt: Math.floor(new Date(draft.closeAt).getTime() / 1000),
        });
        const transactionHash = created.transactionHash ?? child.creationTxHash;
        await this.deps.db.$transaction(async tx => {
          await tx.creationChild.update({
            where: { id: child.id },
            data: { status: 'CREATED', marketAddress: created.market, creationTxHash: transactionHash, failureCode: null, failureDetail: null },
          });
          // One statement per child, ordered after the payment by its derived sequence. A child
          // that failed publishes nothing, and a retry that skips an existing child records
          // nothing new, because the statement's id is derived from the request and position.
          await this.recordCreation(tx, request, { address: created.market, transactionHash, position: child.position });
          await recordLiveEvents(tx, [creationMessage(id, { position: child.position, marketAddress: created.market.toLowerCase(), status: 'CREATING' })]);
          if (request.eventId) {
            // Stored lower-cased, as every address in this schema is: the unique index on it and
            // the lookup that finds a market's event both depend on one canonical form.
            await tx.eventMarket.updateMany({
              where: { eventId: request.eventId, position: child.position },
              data: { marketAddress: created.market.toLowerCase() },
            });
          }
        });
        deployed++;
      } catch (error) {
        failed++;
        const detail = error instanceof Error ? error.message.slice(0, 200) : 'creation_failed';
        await this.deps.db.creationChild.update({
          where: { id: child.id }, data: { status: 'FAILED', failureCode: 'creation_failed', failureDetail: detail },
        });
      }
    }
    if (failed > 0) {
      await this.deps.db.creationRequest.update({
        where: { id },
        data: { status: 'FAILED', failureCode: 'group_partially_created',
          failureDetail: `${failed} of ${selected.length} markets failed; the ${selected.length - failed} that exist are never recreated on retry.` },
      });
      // Thrown so the durable job retries with backoff, exactly as a standalone failure does.
      // Every market already created stays created, and no payment is touched.
      throw new WorkflowError('group_partially_created');
    }
    // `deployed` counts what this run broadcast; a replayed job for a complete group deploys
    // nothing and simply confirms the request, which is what makes the job safe to redeliver.
    void deployed;
    return this.deps.db.$transaction(async tx => {
      if (request.eventId && request.event) {
        await tx.marketEvent.update({ where: { id: request.eventId }, data: { status: 'ACTIVE' } });
        await this.announceEvent(tx, { id, event: request.event }, selected.length);
      }
      return tx.creationRequest.update({
        where: { id }, data: { status: 'CREATED', failureCode: null, failureDetail: null }, include: REQUEST_INCLUDE,
      });
    });
  }
}
