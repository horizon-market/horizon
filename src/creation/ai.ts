import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { AiConfig } from '../config.js';
import { findDuplicates } from './duplicates.js';
import { DraftError, draftSchema, duplicateSchema, type DraftRequest, type DraftResult, type MarketContext, type MarketDraftProvider } from './types.js';

const HOUR = 3600_000;
const CATEGORIES: [RegExp, string][] = [
  [/\b(btc|bitcoin|eth|ethereum|token|onchain|on-chain|defi|stablecoin|usdc)\b/i, 'Crypto'],
  [/\b(election|vote|senate|parliament|president|policy|law|bill)\b/i, 'Politics'],
  [/\b(match|cup|league|tournament|championship|olympic|score|team)\b/i, 'Sports'],
  [/\b(model|ai|llm|gpu|chip|launch|release|ship|version)\b/i, 'Technology'],
  [/\b(gdp|inflation|rate|unemployment|earnings|revenue|ipo)\b/i, 'Economics'],
  [/\b(weather|hurricane|temperature|climate|rainfall)\b/i, 'Climate'],
];

function categoryFor(question: string): string {
  return CATEGORIES.find(([pattern]) => pattern.test(question))?.[1] ?? 'General';
}

function normalizeQuestion(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return capitalized.endsWith('?') ? capitalized : `${capitalized}?`;
}

function closeAtFor(requested: string | undefined, now: Date): string {
  const fallback = new Date(Math.ceil((now.getTime() + 7 * 24 * HOUR) / HOUR) * HOUR);
  if (!requested) return fallback.toISOString();
  const parsed = new Date(requested);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) return fallback.toISOString();
  return parsed.toISOString();
}

/**
 * Deterministic drafting used when no AI credential is configured. It still reads the live
 * indexed market set for duplicate detection, and is labelled `development` everywhere it
 * appears so no response implies a live model call.
 */
export class DevelopmentDraftProvider implements MarketDraftProvider {
  readonly name = 'horizon-deterministic';
  readonly mode = 'development' as const;
  constructor(private now: () => Date = () => new Date()) {}
  async draft(request: DraftRequest, context: MarketContext): Promise<DraftResult> {
    const question = normalizeQuestion(request.question);
    const closeAt = closeAtFor(request.closeAt, this.now());
    const category = request.category?.trim() || categoryFor(question);
    const draft = draftSchema.parse({
      question, yesOutcome: 'YES', noOutcome: 'NO', category, closeAt,
      rules: `YES resolves if, at or before ${closeAt}, the stated condition of "${question}" is established by the named evidence source. `
        + 'NO resolves if the condition is not established by that time. INVALID resolves, paying 0.5 USDC per outcome token, if the evidence source '
        + 'cannot settle the question unambiguously or the question turns out to be undecidable as written. The disclosed Horizon resolver submits the '
        + 'result with an evidence reference after trading closes; there is no dispute process in this release.',
      evidenceSource: 'Primary public record named by the requester, checked by the disclosed Horizon resolver at close.',
    });
    return {
      draft, duplicates: findDuplicates(question, context.markets), provider: this.name, mode: this.mode,
      groundedOnBlock: context.indexedBlock,
      rationale: 'Deterministic development draft. No AI credential is configured, so wording, rules and duplicate warnings come from fixed rules '
        + 'applied to the live indexed market set rather than from a language model.',
    };
  }
}

const responseSchema = z.object({
  question: z.string(), yesOutcome: z.string(), noOutcome: z.string(), category: z.string(),
  closeAt: z.string(), rules: z.string(), evidenceSource: z.string(),
  rationale: z.string().max(2000),
  duplicates: z.array(z.object({ market: z.string(), reason: z.string().max(300), similarity: z.number().min(0).max(1) })).max(5).default([]),
});

const SYSTEM = [
  'You draft binary prediction markets for Horizon, a fully collateralized YES/NO market venue.',
  'You never create a market yourself: a human reviews and approves your exact draft before any payment or on-chain creation.',
  'Rules must resolve to exactly one of YES, NO or INVALID from public evidence. INVALID pays 0.5 USDC per outcome token.',
  'Resolution is centralized and disclosed: a named Horizon resolver submits the result with an evidence reference after trading closes.',
  'You are given the live indexed market set. Only cite duplicate market ids that appear in it. Never invent a market id, and never claim a market exists that is not listed.',
  'Reply with one JSON object and nothing else, using exactly these keys: question, yesOutcome, noOutcome, category, closeAt, rules, evidenceSource, rationale, duplicates.',
  'closeAt is an ISO 8601 UTC timestamp strictly in the future. duplicates is an array of {market, reason, similarity} where similarity is between 0 and 1.',
].join(' ');

/** Production integration boundary. Any failure surfaces as an error; it never falls back silently. */
export class AnthropicDraftProvider implements MarketDraftProvider {
  readonly name = 'anthropic';
  readonly mode = 'live' as const;
  private client: Anthropic;
  constructor(private config: AiConfig) {
    if (!config.apiKey) throw new DraftError('ai_credential_missing');
    this.client = new Anthropic({ apiKey: config.apiKey, maxRetries: 1, timeout: 60_000 });
  }
  async draft(request: DraftRequest, context: MarketContext): Promise<DraftResult> {
    const listing = context.markets.slice(0, 50)
      .map(market => `- ${market.id} | closes ${market.closeAt} | ${market.question}`).join('\n') || '- (no markets indexed yet)';
    const prompt = [
      `Requested question: ${request.question}`,
      request.category ? `Requested category: ${request.category}` : '',
      request.closeAt ? `Requested close time: ${request.closeAt}` : 'Requested close time: not specified; choose a defensible one.',
      `Requester kind: ${request.requesterKind}`,
      `Live indexed markets at block ${context.indexedBlock}:`, listing,
    ].filter(Boolean).join('\n');
    let response;
    try {
      response = await this.client.messages.create({
        model: this.config.model, max_tokens: 4000, system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      });
    } catch {
      throw new DraftError('ai_provider_unavailable');
    }
    if (response.stop_reason === 'refusal') throw new DraftError('ai_provider_declined');
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
    const json = text.startsWith('```') ? text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim() : text;
    let parsed;
    try { parsed = responseSchema.parse(JSON.parse(json)); }
    catch { throw new DraftError('ai_draft_invalid'); }
    const draft = draftSchema.safeParse({
      question: parsed.question.trim(), yesOutcome: parsed.yesOutcome.trim(), noOutcome: parsed.noOutcome.trim(),
      category: parsed.category.trim(), closeAt: new Date(parsed.closeAt).toISOString(), rules: parsed.rules.trim(),
      evidenceSource: parsed.evidenceSource.trim(),
    });
    if (!draft.success) throw new DraftError('ai_draft_invalid');
    // Keep only cited markets that exist in the live indexed set, then add any overlap the
    // model missed. Duplicate warnings therefore always reference real indexed markets.
    const indexed = new Map(context.markets.map(market => [market.id.toLowerCase(), market]));
    const cited = parsed.duplicates.flatMap(entry => {
      const market = indexed.get(entry.market.toLowerCase());
      if (!market) return [];
      const warning = duplicateSchema.safeParse({
        market: market.id, question: market.question, closeAt: market.closeAt,
        similarity: Math.round(entry.similarity * 100) / 100, reason: entry.reason,
      });
      return warning.success ? [warning.data] : [];
    });
    const detected = findDuplicates(draft.data.question, context.markets);
    const duplicates = [...cited, ...detected.filter(entry => !cited.some(other => other.market.toLowerCase() === entry.market.toLowerCase()))].slice(0, 5);
    return { draft: draft.data, duplicates, provider: `${this.name}:${this.config.model}`, mode: this.mode,
      groundedOnBlock: context.indexedBlock, rationale: parsed.rationale.trim() };
  }
}

export function createDraftProvider(config: AiConfig): MarketDraftProvider {
  return config.provider === 'anthropic' && config.apiKey ? new AnthropicDraftProvider(config) : new DevelopmentDraftProvider();
}
