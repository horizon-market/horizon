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
