import { draftSchema, type MarketDraft } from '../creation/types.js';
import { eventUrl, marketUrl, type GammaEvent, type GammaMarket } from './polymarket.js';

/**
 * Turns one Polymarket event into Horizon drafts, or explains exactly why it cannot.
 *
 * Nothing here decides anything on its own. Every judgement it makes leaves a warning behind, and
 * a `blocking` warning removes the child from what can be created rather than silently repairing
 * it. What is imported is a definition — question, outcome labels, resolution criteria, evidence
 * source and dates. Source prices, liquidity, volume and settlement state are read only so they
 * can be recognised, reported as source context, and left out of every Horizon field.
 */

export type Severity = 'blocking' | 'review' | 'info';
export type ImportWarning = { code: string; severity: Severity; message: string };

export type NormalizedDates = {
  /** What Horizon will close trading at, in ISO 8601. */
  tradingCloseAt: string | null;
  sourceEndDate: string | null;
  sourceStartDate: string | null;
  sourceGameStart: string | null;
  /** True when the source's own dates do not agree on when trading should stop. */
  ambiguous: boolean;
};

export type NormalizedChild = {
  position: number;
  outcomeLabel: string;
  question: string;
  /** Present only when this child can be created as it stands. */
  draft?: MarketDraft;
  supported: boolean;
  /** Whether the flow should preselect it. A placeholder or a partial-page import is not. */
  preselected: boolean;
  warnings: ImportWarning[];
  /** Every change made to the source text so it can settle on Horizon, stated plainly. */
  ruleChanges: string[];
  dates: NormalizedDates;
  source: {
    provider: 'polymarket';
    marketId: string;
    slug: string;
    url: string;
    conditionId: string;
    outcomes: string[];
    /** The source's resolution criteria, kept verbatim. */
    description: string;
    resolutionSource: string;
    resolvedBy: string;
    umaResolutionStatuses: string[];
    closed: boolean;
    active: boolean;
    archived: boolean;
    imageUrl: string;
  };
};

export type NormalizedEvent = {
  title: string;
  description: string;
  category: string;
  tags: string[];
  imageUrl: string;
  iconUrl: string;
  exclusivity: 'EXCLUSIVE' | 'COLLECTION';
  exclusivityNote: string;
  source: {
    provider: 'polymarket';
    eventId: string;
    slug: string;
    url: string;
    startDate: string | null;
    endDate: string | null;
    startTime: string | null;
    closed: boolean;
    active: boolean;
    archived: boolean;
    negRisk: boolean;
    series: string[];
    resolutionSource: string;
  };
  children: NormalizedChild[];
  warnings: ImportWarning[];
  /** The definitional metadata as returned, minus every market-data field. */
  snapshot: Record<string, unknown>;
};

export type NormalizeOptions = {
  now?: Date;
  bounds?: { minSeconds: number; maxSeconds: number };
  /** Set when the address named one child; only that child is preselected. */
  focusMarketSlug?: string;
  maxChildren?: number;
};

const MAX_RULES = 2000;
const MAX_QUESTION = 200;
const MIN_QUESTION = 15;
const MAX_EVIDENCE = 500;

/**
 * The settlement terms Horizon adds to every imported market. Importing a definition never
 * delegates settlement: the disclosed Horizon resolver decides, using the source's criteria as
 * the standard, and INVALID is the explicit escape when those criteria cannot decide.
 */
export const HORIZON_SETTLEMENT_CLAUSE =
  'Horizon settlement: after trading closes, the disclosed Horizon resolver submits YES, NO or INVALID against the criteria above '
  + 'together with an evidence reference. INVALID pays 0.5 USDC per outcome token and is the result whenever those criteria cannot '
  + 'settle the question unambiguously — including cancellation of the underlying event where the criteria above do not already decide it. '
  + 'Horizon does not delegate settlement to Polymarket, UMA or any other oracle, and this release has no dispute process.';

const string = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const bool = (value: unknown): boolean => value === true || value === 'true';

/** Gamma returns `["Yes", "No"]` as a JSON string on some fields and as an array on others. */
export function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(entry => string(entry)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(entry => string(entry)).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Gamma mixes ISO 8601 with Postgres-style stamps such as `2026-09-10 19:00:00+00`. Anything that
 * does not read as a real instant becomes null rather than an invented date.
 */
export function toInstant(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00Z`
    : raw.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Labels Polymarket uses for outcomes that do not exist yet, or for a residual bucket. */
const PLACEHOLDER_LABEL = [
  /^(team|player|candidate|option|driver|fighter|horse|entrant|contestant)\s+[a-z]$/i,
  /^(tbd|tba|t\.b\.d\.|n\/a|na|unknown|placeholder|other|another team|another candidate|someone else|field)$/i,
];
export const isPlaceholderLabel = (label: string) => PLACEHOLDER_LABEL.some(pattern => pattern.test(label.trim()));

const clip = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
};

export const slugify = (value: string) =>
  value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';

const warn = (code: string, severity: Severity, message: string): ImportWarning => ({ code, severity, message });

/**
 * The snapshot Horizon keeps. Every definitional field the source returned is preserved exactly;
 * price, liquidity, volume, order-book and reward fields are dropped on the way in, so Polymarket
 * market data cannot reach a Horizon surface even by accident later.
 */
const EVENT_SNAPSHOT_FIELDS = ['id', 'ticker', 'slug', 'title', 'description', 'resolutionSource', 'startDate', 'endDate',
  'creationDate', 'startTime', 'closedTime', 'image', 'icon', 'category', 'subcategory', 'active', 'closed', 'archived',
  'restricted', 'negRisk', 'enableNegRisk', 'negRiskMarketID', 'showAllOutcomes'] as const;
const MARKET_SNAPSHOT_FIELDS = ['id', 'question', 'conditionId', 'slug', 'description', 'resolutionSource', 'outcomes',
  'startDate', 'endDate', 'endDateIso', 'startDateIso', 'gameStartTime', 'closedTime', 'groupItemTitle', 'groupItemThreshold',
  'image', 'icon', 'active', 'closed', 'archived', 'restricted', 'resolvedBy', 'umaResolutionStatus', 'umaResolutionStatuses',
  'umaBond', 'negRisk', 'negRiskMarketID', 'sportsMarketType', 'marketType'] as const;

const pick = (source: Record<string, unknown>, fields: readonly string[]) =>
  Object.fromEntries(fields.filter(field => source[field] !== undefined && source[field] !== null).map(field => [field, source[field]]));

export function snapshotMarket(market: GammaMarket): Record<string, unknown> {
  return pick(market as Record<string, unknown>, MARKET_SNAPSHOT_FIELDS);
}

export function snapshotEvent(event: GammaEvent): Record<string, unknown> {
  const raw = event as Record<string, unknown>;
  return {
    ...pick(raw, EVENT_SNAPSHOT_FIELDS),
    tags: (event.tags ?? []).map(tag => ({ id: string(tag.id), label: string(tag.label), slug: string(tag.slug) })),
    series: (event.series ?? []).map(entry => ({ id: string(entry.id), slug: string(entry.slug), title: string(entry.title) })),
    // Recorded so a reader of the row knows what was deliberately not kept.
    excludedFields: 'Source prices, liquidity, volume, order-book state and rewards are not stored: they are not Horizon data.',
    capturedAt: new Date().toISOString(),
  };
}

/** Trading close time, and whether the source's own dates disagree about it. */
export function mapDates(market: GammaMarket, event: GammaEvent): NormalizedDates {
  const sourceEndDate = toInstant(market.endDate) ?? toInstant(market.endDateIso) ?? toInstant(event.endDate);
  const sourceStartDate = toInstant(market.startDate) ?? toInstant(event.startDate);
  const sourceGameStart = toInstant(market.gameStartTime) ?? toInstant(event.startTime);
  if (!sourceEndDate) return { tradingCloseAt: null, sourceEndDate, sourceStartDate, sourceGameStart, ambiguous: false };
  if (!sourceGameStart) return { tradingCloseAt: sourceEndDate, sourceEndDate, sourceStartDate, sourceGameStart, ambiguous: false };
  const end = Date.parse(sourceEndDate), start = Date.parse(sourceGameStart);
  // The common sports shape has both stamps at kick-off and needs no judgement. When they differ,
  // Horizon stops trading at the earlier one and says so, because on Horizon the close time is
  // when trading stops, while Polymarket's end date is when the underlying question is settled.
  if (start === end) return { tradingCloseAt: sourceEndDate, sourceEndDate, sourceStartDate, sourceGameStart, ambiguous: false };
  return { tradingCloseAt: new Date(Math.min(start, end)).toISOString(), sourceEndDate, sourceStartDate, sourceGameStart, ambiguous: true };
}

function childLabel(market: GammaMarket, question: string): string {
  const grouped = string(market.groupItemTitle);
  if (grouped) return clip(grouped, 80);
  // A standalone market has no group label; its own question is the outcome it describes.
  return clip(question || string(market.slug) || 'Outcome', 80);
}

function normalizeChild(market: GammaMarket, event: GammaEvent, position: number, options: Required<Pick<NormalizeOptions, 'now' | 'bounds'>>): NormalizedChild {
  const warnings: ImportWarning[] = [];
  const ruleChanges: string[] = [];
  const slug = string(market.slug);
  const rawQuestion = string(market.question);
  const outcomes = jsonArray(market.outcomes);
  const umaStatuses = jsonArray(market.umaResolutionStatuses).concat(string(market.umaResolutionStatus) ? [string(market.umaResolutionStatus)] : []);
  const dates = mapDates(market, event);
  const closed = bool(market.closed), archived = bool(market.archived);
  const active = market.active === undefined || market.active === null ? true : bool(market.active);

  let question = rawQuestion;
  if (question.length > MAX_QUESTION) {
    question = clip(question, MAX_QUESTION);
    ruleChanges.push(`The source question is longer than Horizon's ${MAX_QUESTION}-character limit and was shortened to "${question}". The full text is kept in the source snapshot.`);
    warnings.push(warn('question_shortened', 'review', 'The source question was too long for Horizon and has been shortened. Check that it still says the same thing.'));
  }
  if (question.length < MIN_QUESTION) {
    warnings.push(warn('question_too_short', 'blocking', `Horizon needs a question of at least ${MIN_QUESTION} characters; the source supplied ${question.length}.`));
  }

  // Horizon markets are fully collateralized YES/NO pairs. Anything else is not importable, and
  // the actual outcome labels are named so a reviewer can see what was refused.
  const binary = outcomes.length === 2 && outcomes.map(entry => entry.toLowerCase()).join('/') === 'yes/no';
  if (!binary) {
    warnings.push(warn('unsupported_outcomes', 'blocking',
      outcomes.length === 0
        ? 'The source market publishes no outcome labels, so Horizon cannot confirm it is a YES/NO market.'
        : `Horizon creates YES/NO markets only. This source market offers ${outcomes.length} outcome${outcomes.length === 1 ? '' : 's'}: ${outcomes.join(', ')}.`));
  }
  if (closed || archived || !active) {
    warnings.push(warn('source_market_closed', 'blocking',
      `The source market is ${[closed && 'closed', archived && 'archived', !active && 'inactive'].filter(Boolean).join(' and ')}. A finished question cannot be opened for trading on Horizon.`));
  }
  if (umaStatuses.length > 0) {
    warnings.push(warn('source_resolution_in_progress', 'review',
      `The source market has a resolution status of ${umaStatuses.join(', ')}. Confirm the question is still undecided before creating it on Horizon.`));
  }

  const outcomeLabel = childLabel(market, question);
  const placeholder = isPlaceholderLabel(outcomeLabel) || isPlaceholderLabel(string(market.groupItemTitle));
  if (placeholder) {
    warnings.push(warn('placeholder_outcome', 'blocking',
      `"${outcomeLabel}" is a placeholder the source has not filled in yet, not a real outcome. It is left out rather than created as a market nobody can resolve.`));
  }

  // Resolution criteria. The source text is the standard; Horizon's own settlement terms are
  // appended, never substituted, and both the addition and any shortening are reported.
  const sourceRules = string(market.description) || string(event.description);
  if (!sourceRules) {
    warnings.push(warn('missing_source_rules', 'blocking', 'The source publishes no resolution criteria for this market, so Horizon has nothing to resolve against.'));
  }
  const budget = MAX_RULES - HORIZON_SETTLEMENT_CLAUSE.length - 2;
  const keptRules = sourceRules.length > budget ? clip(sourceRules, budget) : sourceRules;
  if (keptRules !== sourceRules) {
    ruleChanges.push(`The source criteria are longer than Horizon's ${MAX_RULES}-character limit and were shortened. The full text is kept in the source snapshot.`);
    warnings.push(warn('rules_shortened', 'review', 'The source resolution criteria were too long for Horizon and have been shortened. Review what remains before approving.'));
  }
  ruleChanges.push('Horizon settlement terms were appended: the disclosed Horizon resolver decides YES, NO or INVALID, and INVALID pays 0.5 USDC per outcome token. Settlement is not delegated to Polymarket or UMA.');
  const rules = `${keptRules}\n\n${HORIZON_SETTLEMENT_CLAUSE}`;

  const evidenceSource = clip(
    string(market.resolutionSource) || string(event.resolutionSource)
      || `Polymarket market "${slug}" as published at ${marketUrl(string(event.slug) || undefined, slug)}, and the primary public record its criteria name.`,
    MAX_EVIDENCE);
  if (!string(market.resolutionSource) && !string(event.resolutionSource)) {
    ruleChanges.push('The source names no evidence source, so the evidence reference points at the source market page and the record its criteria name.');
    warnings.push(warn('evidence_source_derived', 'review', 'The source names no evidence source. Horizon derived one from the source page; confirm it is checkable at close.'));
  }

  // Dates. A close time Horizon cannot accept is refused with the bound named, rather than moved.
  if (!dates.tradingCloseAt) {
    warnings.push(warn('missing_close_time', 'blocking', 'The source publishes no end date for this market, so Horizon has no time to close trading at.'));
  } else {
    const seconds = Math.floor((Date.parse(dates.tradingCloseAt) - options.now.getTime()) / 1000);
    if (seconds <= options.bounds.minSeconds) {
      warnings.push(warn('close_time_too_soon', 'blocking',
        `Trading would close at ${dates.tradingCloseAt}, which is inside Horizon's minimum of ${Math.round(options.bounds.minSeconds / 3600)} hour(s) from now.`));
    } else if (seconds > options.bounds.maxSeconds) {
      warnings.push(warn('close_time_too_far', 'blocking',
        `Trading would close at ${dates.tradingCloseAt}, beyond Horizon's maximum of ${Math.round(options.bounds.maxSeconds / 86400)} days from now.`));
    }
  }
  if (dates.ambiguous) {
    warnings.push(warn('date_mapping_ambiguous', 'review',
      `The source gives a start time of ${dates.sourceGameStart} and an end date of ${dates.sourceEndDate}. Horizon closes trading at the earlier of the two; confirm that is when betting should stop.`));
    ruleChanges.push(`Trading closes at ${dates.tradingCloseAt}, the earlier of the source's start time and end date. The source's own end date is when it settles the question, which is not the same thing.`);
  }

  const category = clip(string(event.category) || string((event.tags ?? [])[0]?.label) || 'General', 40) || 'General';
  const blocking = warnings.some(entry => entry.severity === 'blocking');
  let draft: MarketDraft | undefined;
  if (!blocking && dates.tradingCloseAt) {
    const parsed = draftSchema.safeParse({
      question, yesOutcome: 'YES', noOutcome: 'NO', category: category.length < 2 ? 'General' : category,
      closeAt: dates.tradingCloseAt, rules, evidenceSource,
    });
    if (parsed.success) draft = parsed.data;
    else warnings.push(warn('draft_rejected', 'blocking',
      `Horizon refused the normalized draft: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'draft'} ${issue.message.toLowerCase()}`).join('; ')}.`));
  }

  const supported = Boolean(draft);
  return {
    position, outcomeLabel, question, draft, supported,
    preselected: supported && !placeholder,
    warnings, ruleChanges, dates,
    source: {
      provider: 'polymarket', marketId: string(market.id), slug,
      url: marketUrl(string(event.slug) || undefined, slug), conditionId: string(market.conditionId),
      outcomes, description: string(market.description), resolutionSource: string(market.resolutionSource),
      resolvedBy: string(market.resolvedBy), umaResolutionStatuses: umaStatuses,
      closed, active, archived, imageUrl: string(market.image) || string(market.icon),
    },
  };
}

/** Everything the preview shows, and everything an import writes, derives from this one function. */
export function normalizeEvent(event: GammaEvent, options: NormalizeOptions = {}): NormalizedEvent {
  const now = options.now ?? new Date();
  const bounds = options.bounds ?? { minSeconds: 3600, maxSeconds: 365 * 24 * 3600 };
  const maxChildren = options.maxChildren ?? 24;
  const warnings: ImportWarning[] = [];
  const slug = string(event.slug);
  const title = clip(string(event.title) || slug || 'Imported event', 200);
  const closed = bool(event.closed), archived = bool(event.archived);
  const active = event.active === undefined || event.active === null ? true : bool(event.active);
  if (closed || archived || !active) {
    warnings.push(warn('source_event_closed', 'blocking',
      `The source event is ${[closed && 'closed', archived && 'archived', !active && 'inactive'].filter(Boolean).join(' and ')}, so none of its markets can be opened for trading on Horizon.`));
  }

  const all = event.markets ?? [];
  if (all.length === 0) warnings.push(warn('source_event_empty', 'blocking', 'The source event publishes no markets.'));
  const considered = all.slice(0, maxChildren);
  if (all.length > considered.length) {
    warnings.push(warn('children_truncated', 'review',
      `The source event has ${all.length} markets and Horizon reviews at most ${maxChildren} per import. The first ${considered.length} are shown; the rest are not part of this import.`));
  }

  const children = considered.map((market, index) => normalizeChild(market, event, index, { now, bounds }));
  if (warnings.some(entry => entry.severity === 'blocking')) {
    // A dead event makes every child unimportable regardless of its own state.
    for (const child of children) { child.supported = false; child.preselected = false; delete child.draft; }
  }

  // A market address preselects only the child it named, which is never an exhaustive set.
  if (options.focusMarketSlug) {
    const found = children.find(child => child.source.slug === options.focusMarketSlug);
    for (const child of children) child.preselected = child === found && child.supported;
    if (!found) warnings.push(warn('focus_market_not_in_event', 'review', 'The address named a market that is not among this event\'s markets. Choose the children to import yourself.'));
    else warnings.push(warn('single_market_address', 'info',
      `The address named one market inside "${title}". Only that market is selected; its siblings are shown so the group context is visible.`));
  }

  const negRisk = bool(event.negRisk) || bool(event.enableNegRisk);
  const supported = children.filter(child => child.supported).length;
  if (supported === 0 && !warnings.some(entry => entry.severity === 'blocking')) {
    warnings.push(warn('no_supported_markets', 'blocking', 'None of this event\'s markets can be created on Horizon as they stand. The reasons are listed against each one.'));
  }
  if (supported > 0 && supported < children.length) {
    warnings.push(warn('partial_outcome_set', 'review',
      `${children.length - supported} of ${children.length} source markets cannot be created on Horizon. The imported group will not cover every outcome the source offers.`));
  }

  return {
    title,
    description: clip(string(event.description), 4000),
    category: clip(string(event.category) || string((event.tags ?? [])[0]?.label) || 'General', 40),
    tags: (event.tags ?? []).map(tag => string(tag.label)).filter(Boolean).slice(0, 12),
    imageUrl: string(event.image), iconUrl: string(event.icon) || string(event.image),
    exclusivity: negRisk ? 'EXCLUSIVE' : 'COLLECTION',
    exclusivityNote: negRisk
      ? 'The source groups these markets as mutually exclusive: exactly one of them is meant to resolve YES. Horizon records that rule and checks proposed resolutions against already resolved siblings; the market contracts themselves know nothing about it. Each child still holds its own collateral, and shared collateral and negative-risk conversion are not implemented.'
      : 'The source does not state that exactly one of these markets wins. They are grouped for context only, and their prices need not add up to 100%.',
    source: {
      provider: 'polymarket', eventId: string(event.id), slug, url: eventUrl(slug),
      startDate: toInstant(event.startDate), endDate: toInstant(event.endDate), startTime: toInstant(event.startTime),
      closed, active, archived, negRisk,
      series: (event.series ?? []).map(entry => string(entry.slug)).filter(Boolean),
      resolutionSource: string(event.resolutionSource),
    },
    children, warnings, snapshot: snapshotEvent(event),
  };
}

/** True when every market the source offers is present, supported and selected. */
export function outcomesComplete(normalized: NormalizedEvent, selected: Set<number>): boolean {
  const noneDropped = !normalized.warnings.some(entry => entry.code === 'children_truncated' || entry.code === 'partial_outcome_set');
  return noneDropped && normalized.children.length > 0
    && normalized.children.every(child => child.supported && selected.has(child.position));
}
