import { z } from 'zod';
import { createHash } from 'node:crypto';

/** The exact market a human must approve before any payment or on-chain creation. */
export const draftSchema = z.object({
  question: z.string().trim().min(15).max(200),
  yesOutcome: z.string().trim().min(1).max(80),
  noOutcome: z.string().trim().min(1).max(80),
  category: z.string().trim().min(2).max(40),
  closeAt: z.string().datetime(),
  rules: z.string().trim().min(40).max(2000),
  evidenceSource: z.string().trim().min(5).max(500),
}).strict();
export type MarketDraft = z.infer<typeof draftSchema>;

export const duplicateSchema = z.object({
  market: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  question: z.string().max(300),
  closeAt: z.string(),
  similarity: z.number().min(0).max(1),
  reason: z.string().max(300),
}).strict();
export type DuplicateWarning = z.infer<typeof duplicateSchema>;

export type IndexedMarket = { id: string; question: string; closeAt: string; result: number };
export type MarketContext = { indexedBlock: number; markets: IndexedMarket[] };
export type DraftRequest = { question: string; category?: string; closeAt?: string; requesterKind: 'browser' | 'agent' };
export type DraftResult = {
  draft: MarketDraft; duplicates: DuplicateWarning[]; rationale: string;
  provider: string; mode: 'live' | 'development'; groundedOnBlock: number;
};

/** A provider proposes; a human approves. Swapping this interface must not change the review gate. */
export interface MarketDraftProvider {
  readonly name: string;
  readonly mode: 'live' | 'development';
  draft(request: DraftRequest, context: MarketContext): Promise<DraftResult>;
}

export class DraftError extends Error {}

/** Approval binds to this hash, so a draft that changed after review cannot be paid for. */
export function draftHash(draft: MarketDraft): string {
  const canonical = JSON.stringify([draft.question, draft.yesOutcome, draft.noOutcome, draft.category, draft.closeAt, draft.rules, draft.evidenceSource]);
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Events. An event is a durable grouping of independent binary markets. Being in
// one says nothing about the children's outcomes on its own: only EXCLUSIVE says
// the rules pick exactly one winner, and even that is a service-side rule, not
// something the market contracts know about.
// ---------------------------------------------------------------------------
export const EXCLUSIVITY = ['COLLECTION', 'EXCLUSIVE'] as const;
export type Exclusivity = typeof EXCLUSIVITY[number];

/** The event metadata a human approves, alongside the child drafts. */
export const eventDraftSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).default(''),
  category: z.string().trim().min(2).max(40),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  imageUrl: z.string().trim().max(500).default(''),
  iconUrl: z.string().trim().max(500).default(''),
  exclusivity: z.enum(EXCLUSIVITY),
  exclusivityNote: z.string().trim().max(1000).default(''),
  /** Whether the selected children cover every outcome the source or author offers. */
  outcomesComplete: z.boolean().default(false),
}).strict();
export type EventDraft = z.infer<typeof eventDraftSchema>;

/** Where an imported definition came from. Absent on a manually authored event. */
export const provenanceSchema = z.object({
  provider: z.string().trim().min(2).max(40),
  eventId: z.string().trim().max(120),
  eventSlug: z.string().trim().max(200).default(''),
  url: z.string().trim().max(500),
  importedAt: z.string().datetime(),
}).strict();
export type Provenance = z.infer<typeof provenanceSchema>;

export type ChildPlan = {
  position: number;
  outcomeLabel: string;
  draft: MarketDraft;
  /** SKIPPED children are deselected: neither priced nor deployed. */
  selected: boolean;
};

export type GroupPlan = {
  event: EventDraft;
  children: ChildPlan[];
  /** The undiscounted group price shown before approval, in creation-asset base units. */
  pricing: { baseUnits: bigint; quantity: number; totalUnits: bigint };
  provenance?: Provenance;
};

/**
 * Approval binds to the whole plan: the event metadata, the exact drafts of the children that
 * were selected, their order and labels, the provenance, and the price that was shown. Changing
 * any of them — including deselecting a child, which changes both the set and the price —
 * produces a different hash, and a stored approval no longer matches.
 */
export function groupPlanHash(plan: GroupPlan): string {
  const event = plan.event;
  const canonical = JSON.stringify([
    'horizon-group-plan-v1',
    [event.title, event.description, event.category, event.tags.join('\u0000'), event.exclusivity, event.exclusivityNote, event.outcomesComplete],
    plan.children.filter(child => child.selected).sort((a, b) => a.position - b.position)
      .map(child => [child.position, child.outcomeLabel, draftHash(child.draft)]),
    [plan.pricing.baseUnits.toString(), plan.pricing.quantity, plan.pricing.totalUnits.toString()],
    plan.provenance ? [plan.provenance.provider, plan.provenance.eventId, plan.provenance.eventSlug, plan.provenance.url] : null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
