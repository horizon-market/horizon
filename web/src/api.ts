import type { DescribedOrder } from './curve';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) throw new ApiError(response.status, (body as { error?: string })?.error ?? `http_${response.status}`);
  return body as T;
}

export type Fees = { maker: number; taker: number; routing: number; protocol: number; note?: string };
export type AppConfig = {
  chainId: number; fees: Fees;
  trading: { registry: string; router: string; executor: string; aqua: string; usdc: string; decimals: number; maxRouteFills: number } | null;
  creation: { available: boolean; priceUnits: string; discountBps: number; asset: string; assetId: string; assetDecimals: number; network: string; settlementMode: 'live' | 'simulated'; facilitator: string; walletConnectProjectId: string | null; note: string };
  events: {
    available: boolean; sharedCollateral: boolean; negativeRiskConversion: boolean;
    imports: { available: boolean; providers: string[]; maxChildren: number; policy: string; note: string };
  };
  ai: { provider: string; mode: 'live' | 'development' };
  world: { available: boolean; widgetAvailable: boolean; access: string; reason: string; action: string; appId: string; rpId: string; environment: 'sandbox' | 'staging' | 'production' };
  resolution: { centralized: boolean; disclosed: boolean; resolver: string | null; invalidPayout: string; note: string;
    groupConsistency: 'backend_only'; groupConsistencyNote: string };
};
export type SideLiquidity = { ask: number | null; bid: number | null; availableShares: string };
/**
 * One resting order with capacity left. `isLimit` separates a fixed-price order — which belongs in
 * the ladder — from a curve, which reprices as it fills and is drawn from `strategy` instead.
 * `price` is the marginal price at `filled` right now. The reading half of the shape lives in
 * `curve.ts`, which is where the market page's chart and split read it from.
 */
export type Curve = DescribedOrder & {
  strategy: DescribedOrder['strategy'] & { market: string; flags: number; salt: string };
};
export type Market = {
  id: string; question: string; rules: string; evidenceSource: string; closeAt: number; resolver: string;
  yesToken: string; noToken: string; result: number; resolutionEvidence: string; collateral: string; createdAt: number;
  status: 'OPEN' | 'CLOSED' | 'RESOLVED'; liquidity: { yes: SideLiquidity; no: SideLiquidity; curves: number }; curves: Curve[];
};
export type BookLevel = { price: number; shares: string; orders: number; source: 'direct' | 'complementary' | 'mixed'; executable: boolean };
export type OutcomeBook = { asks: BookLevel[]; bids: BookLevel[]; spread: number | null };
export type MarketBook = { yes: OutcomeBook; no: OutcomeBook };
/**
 * An event groups independent binary markets. Membership alone says nothing about their outcomes:
 * only `exclusivity: 'EXCLUSIVE'` means the rules pick exactly one winner, and even then the rule
 * is checked by Horizon's resolution workflow, not by the market contracts.
 */
export type EventChild = {
  position: number; outcomeLabel: string; question: string;
  marketAddress: string | null;
  /** Horizon market state, present once the child is deployed and indexed. */
  market: Market | null;
  source: { slug: string | null; url: string | null } | null;
};
export type HorizonEvent = {
  id: string; slug: string; title: string; description: string; category: string; tags: string[];
  imageUrl: string | null; iconUrl: string | null;
  exclusivity: 'COLLECTION' | 'EXCLUSIVE'; exclusivityNote: string; outcomesComplete: boolean; status: string;
  source: { provider: string; eventId: string | null; slug: string | null; url: string | null; importedAt: string | null };
  createdAt: string; children: EventChild[];
  stats: { markets: number; live: number; open: number; resolved: number; curves: number; collateral: string };
  exclusivityEnforcement: 'backend_only' | 'none';
};
export type EventList = { indexedBlock: number | null; marketsError?: string; fees: Fees; events: HorizonEvent[]; note: string };
export type EventDetail = { indexedBlock: number | null; marketsError?: string; fees: Fees; event: HorizonEvent; resolution: { enforcement: string; note: string } };
/** The group a market belongs to, carried alongside the market's own detail. */
export type MarketEventContext = {
  slug: string; title: string; exclusivity: 'COLLECTION' | 'EXCLUSIVE'; exclusivityNote: string;
  outcomesComplete: boolean; exclusivityEnforcement: 'backend_only' | 'none';
  source: { provider: string; url: string | null; importedAt: string | null };
  outcomeLabel: string; position: number;
  siblings: { position: number; outcomeLabel: string; marketAddress: string | null }[];
};
export type MarketList = {
  indexedBlock: number; indexedHash: string; fees: Fees; markets: Market[];
  /** Grouped markets travel with their event; `standalone` names the ones that belong to none. */
  events: HorizonEvent[]; standalone: string[];
};
export type Quote = {
  chainId: number; market: string; shares: string; usdc: string; limit: string; deadline: number; fees: Fees;
  simulation: 'passed' | 'approval_required' | 'insufficient_balance';
  snapshot: { block: string; hash: string; indexedBlock: number; indexedHash: string };
  search: { candidateLimit: number; fillLimit: number; method: string };
  approval: { token: string; spender: string; amount: string };
  transaction: { to: string; data: string; value: string };
  legs: { maker: string; shares: string; expectedFilled: string }[];
};
/** One order's remaining claim on its funding token, as the router's ledger reports it. */
export type OrderCommitment = {
  orderHash: string; token: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  filled: string; owed: string; allocation: string; remaining: string; terminal: boolean;
};
/**
 * One funding asset's budget in one market. USDC covers both outcomes, because a buy order spends
 * USDC whichever side it names; each outcome token carries its own inventory. `spendable` is the
 * lesser of the wallet balance and the Aqua allowance — an allowance is not money. Nothing here is
 * reserved: the same USDC still backs this wallet's other markets.
 */
export type FundingBudget = {
  asset: 'USDC' | 'YES' | 'NO'; token: string; decimals: number;
  balance: string; allowance: string; spendable: string; committed: string; available: string;
  overcommitted: boolean; orders: OrderCommitment[];
};
export type MarketBudgets = {
  block: number; market: string; maker: string; spender: string; marketOpen: boolean;
  usdc: FundingBudget; yes: FundingBudget; no: FundingBudget;
};
export type Publication = {
  strategy: { market: string; flags: number; startPrice: number; endPrice: number; maxShares: string; salt: string };
  orderHash: string; outcomeToken: string; tokens: string[]; amounts: string[]; shared: string;
  readiness: 'ready' | 'approval_required' | 'insufficient_balance' | 'over_budget';
  /** What this order would commit, and what this market already has committed against the same asset. */
  budget: FundingBudget & { block: number; requested: string; required: string; fits: boolean; shortfall: string };
  approval: { token: string; spender: string; amount: string };
  /** Step one: the Aqua allocation. On its own this order can never fill. */
  transaction: { to: string; data: string; value: string };
  /** Step two: the Horizon router admits the order, which is where the market budget is enforced. */
  admission: { to: string; data: string; value: string };
  fees: Fees;
};
export type MakerCurve = {
  orderHash: string; market: string; question: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  shape: number; startPrice: number; endPrice: number; isLimit: boolean;
  maxShares: string; filled: string; remaining: string; active: boolean; publishedAt: number; closeAt: number;
  outcomeToken: string; marketStatus: 'OPEN' | 'CLOSED' | 'RESOLVED'; cancellable: boolean;
  /** Admitted by the router. An order shipped to Aqua without that step holds funds but cannot fill. */
  admitted: boolean; executable: boolean;
};
export type Position = { market: string; question: string; closeAt: number; status: string; result: string; yesToken: string; noToken: string; yes: string; no: string; redeemableUsdc: string };
export type Redemption = { result: string; payoutUsdc: string; transaction: { to: string; data: string; value: string } };
export type MarketDraft = { question: string; yesOutcome: string; noOutcome: string; category: string; closeAt: string; rules: string; evidenceSource: string };
export type ImportWarning = { code: string; severity: 'blocking' | 'review' | 'info'; message: string };
export type ImportDates = { tradingCloseAt: string | null; sourceEndDate: string | null; sourceStartDate: string | null; sourceGameStart: string | null; ambiguous: boolean };
/** One child inside a group request, with its own deployment state. */
export type RequestChild = {
  position: number; outcomeLabel: string; draft: MarketDraft | null; draftHash: string;
  status: 'PENDING' | 'SKIPPED' | 'CREATING' | 'CREATED' | 'FAILED';
  marketAddress: string | null; creationTxHash: string | null;
  failureCode: string | null; failureDetail: string | null; attempts: number;
  notes: { warnings: ImportWarning[]; ruleChanges: string[] } | null;
};
export type RequestEvent = {
  id: string; slug: string; title: string; description: string; category: string; tags: string[] | null;
  exclusivity: 'COLLECTION' | 'EXCLUSIVE'; exclusivityNote: string; outcomesComplete: boolean; status: string;
  exclusivityEnforcement: 'backend_only' | 'none';
  source: { provider: string; eventId: string | null; slug: string | null; url: string | null; importedAt: string | null };
  members: { position: number; outcomeLabel: string; question: string; marketAddress: string | null; sourceUrl: string | null }[];
};
/** The explicit group price, shown before approval and bound into the approval hash. */
export type GroupQuote = {
  unitUnits: string; quantity: number; totalUnits: string; discountedTotalUnits: string;
  discountBps: number; asset: string; assetDecimals: number; network: string; note: string;
};
/** What the importer read from a source page, and what Horizon would create from it. */
export type ImportPreview = {
  title: string; description: string; category: string; tags: string[];
  imageUrl: string; iconUrl: string;
  exclusivity: 'COLLECTION' | 'EXCLUSIVE'; exclusivityNote: string;
  source: { provider: string; eventId: string; slug: string; url: string; startDate: string | null; endDate: string | null;
    startTime: string | null; closed: boolean; active: boolean; archived: boolean; negRisk: boolean; series: string[]; resolutionSource: string };
  children: {
    position: number; outcomeLabel: string; question: string; draft: MarketDraft | null;
    supported: boolean; preselected: boolean; warnings: ImportWarning[]; ruleChanges: string[]; dates: ImportDates;
    source: { provider: string; marketId: string; slug: string; url: string; conditionId: string; outcomes: string[];
      description: string; resolutionSource: string; resolvedBy: string; umaResolutionStatuses: string[];
      closed: boolean; active: boolean; archived: boolean; imageUrl: string };
  }[];
  warnings: ImportWarning[];
};
export type ExistingImport = {
  eventId: string; slug: string; title: string; status: string; importedAt: string | null; sourceUrl: string | null;
  markets: { position: number; outcomeLabel: string; question: string; marketAddress: string | null; sourceSlug: string | null }[];
  created: number; requests: { id: string; status: string; createdAt: string }[]; inProgress: boolean;
};
export type ImportPreviewResult = {
  source: { kind: 'event' | 'market'; slug: string; eventSlug?: string; url: string };
  preview: ImportPreview; existing?: ExistingImport; quote: GroupQuote; importPolicy: string;
};
export type ImportRejection = { error: string; preview?: ImportPreview; existing?: ExistingImport; source?: ImportPreviewResult['source'] };

export type CreationRequest = {
  id: string; status: string; question: string; requesterKind: string; requester: string;
  draft: MarketDraft | Record<string, unknown> | null;
  draftHash: string | null; draftProvider: string | null; draftMode: string | null;
  kind: 'SINGLE' | 'GROUP';
  children: RequestChild[];
  event: RequestEvent | null;
  groupQuote?: GroupQuote;
  review: {
    duplicateCheck: string; groundedOnBlock: number; rationale: string;
    warnings: { market: string; question: string; closeAt: string; similarity: number; reason: string }[];
    import?: {
      provider: string; url: string; kind: string; eventId: string; eventSlug: string; importedAt: string;
      eventWarnings: ImportWarning[];
      children: { position: number; outcomeLabel: string; question: string; supported: boolean; selected: boolean;
        warnings: ImportWarning[]; ruleChanges: string[]; dates: ImportDates;
        source: { marketId: string; slug: string; url: string; conditionId: string; outcomes: string[]; resolutionSource: string; closed: boolean } }[];
      sourceRules: { position: number; description: string }[];
    };
  } | null;
  approvedAt: string | null; approvedHash: string | null; discountBps: number; discountNote: string; priceUnits: string;
  marketAddress: string | null; creationTxHash: string | null;
  failureCode: string | null; failureDetail: string | null; attempts: number;
  createdAt: string; updatedAt: string;
  verification: { credentialType: string; verifier: string; verifiedAt: string } | null;
  payment: { status: string; network: string; asset: string; amountUnits: string; payTo: string; facilitator: string; transactionRef: string | null; payer: string | null; settledAt: string | null; failureCode: string | null; attempts: number } | null;
  fees: Fees;
};
/** One row of a requester's own creation history; the full request still needs its access token. */
export type CreationSummary = {
  id: string; question: string; status: string; requesterKind: string;
  marketAddress: string | null; priceUnits: string; discountBps: number;
  failureCode: string | null; createdAt: string; updatedAt: string;
  paymentStatus: string | null; asset: string | null;
  kind: 'SINGLE' | 'GROUP';
  event: { slug: string; title: string; status: string; exclusivity: string; sourceProvider: string } | null;
  children: number; childrenCreated: number;
};
export type PaymentResource = { url: string; description?: string; mimeType?: string };
export type PaymentRequirements = { scheme: string; network: string; amount: string; payTo: string; maxTimeoutSeconds: number; asset: string; extra: { feePayer?: string; nonce: string; assetDecimals: number; settlementMode: string } };
export type AdminMarket = {
  market: string; question: string; closeAt: number; status: string; result: string; resolver: string;
  rules: string; evidenceSource: string; collateral: string; resolutionEvidence: string; curves: number; resolvable: boolean;
};
export type OperatorCurve = {
  id: string; maker: string; market: string; question: string; flags: number; startPrice: number; endPrice: number;
  maxShares: string; filled: string; remaining: string; active: boolean; publishedAt: number; salt: string;
  side: 'YES' | 'NO'; direction: 'BUY' | 'SELL'; shape: number;
  /** Shipped to Aqua and admitted by the router. Only an admitted order can fill. */
  admitted: boolean;
};
export type OperatorFill = {
  id: string; strategy: string; maker: string; market: string; question: string; shares: string; usdc: string;
  block: number; transaction: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
};
export type OperatorRoute = {
  id: string; market: string; question: string; taker: string; recipient: string; isYes: boolean; isBuy: boolean;
  shares: string; usdc: string; fills: number; transaction: string; block: number;
};
export type AdminActivity = { indexedBlock: number; market: string | null; curves: OperatorCurve[]; fills: OperatorFill[]; routes: OperatorRoute[]; fees: Fees };
export type AdminOverview = {
  counts: Record<string, number>;
  markets: AdminMarket[];
  requests: { id: string; status: string; question: string; requesterKind: string; requester: string; draftProvider: string | null; draftMode: string | null; discountBps: number; discountNote: string; priceUnits: string; marketAddress: string | null; creationTxHash: string | null; failureCode: string | null; attempts: number; createdAt: string; verified: boolean; paymentStatus: string | null }[];
  payments: { id: string; requestId: string; status: string; amountUnits: string; asset: string; facilitator: string; transactionRef: string | null; failureCode: string | null; attempts: number; createdAt: string }[];
  resolutions: { id: string; market: string; result: string; status: string; evidence: string; txHash: string | null; failureCode: string | null; attempts: number; createdAt: string }[];
  jobs: { id: string; label: string; completedAt: string }[];
  awaitingResolution: AdminMarket[];
  events: HorizonEvent[];
  marketsError?: string;
  resolverModel: {
    centralized: boolean; disclosed: boolean; resolver: string | null; payouts: Record<string, string>;
    /** Exclusive-group consistency is a workflow check, not an on-chain guarantee. */
    groupConsistency: { enforcement: 'backend_only'; note: string };
  };
};

const post = <T>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });

export const api = {
  config: () => request<AppConfig>('/api/config'),
  markets: () => request<MarketList>('/api/markets'),
  market: (id: string) => request<{ indexedBlock: number; market: Market; book: MarketBook; event: MarketEventContext | null }>(`/api/markets/${id}`),
  events: () => request<EventList>('/api/events'),
  event: (slug: string) => request<EventDetail>(`/api/events/${encodeURIComponent(slug)}`),
  positions: (account: string) => request<{ indexedBlock: number; positions: Position[] }>(`/api/positions/${account}`),
  makerCurves: (account: string) => request<{ indexedBlock: number; curves: MakerCurve[] }>(`/api/curves/${account}`),
  marketBudgets: (market: string, maker: string) => request<MarketBudgets>(`/api/markets/${market}/budgets/${maker}`),
  quote: (input: { market: string; account: string; recipient: string; isYes: boolean; isBuy: boolean; shares: string; slippageBps: number }) => post<Quote>('/api/quotes', input),
  /** `salt` re-prepares the same order rather than a new one, so a review survives an approval. */
  publishCurve: (input: { maker: string; market: string; isYes: boolean; isBuy: boolean; startPrice: number; endPrice: number; shares: string; shape: number; salt?: string }) => post<Publication>('/api/curves', input),
  cancelCurve: (input: { maker: string; market: string; orderHash: string; outcomeToken: string }) => post<{ transaction: { to: string; data: string; value: string } }>('/api/curves/cancellations', input),
  redeem: (input: { account: string; market: string; recipient: string; yesShares: string; noShares: string }) => post<Redemption>('/api/redemptions', input),
  createDraft: (input: { question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string }, idempotencyKey: string) =>
    post<{ request: CreationRequest; accessToken?: string; replay: boolean }>('/api/creation/requests', input, { 'idempotency-key': idempotencyKey }),
  createGroup: (input: {
    requesterKind: 'browser' | 'agent'; requester: string;
    event: { title: string; description?: string; category?: string; exclusivity: 'COLLECTION' | 'EXCLUSIVE'; outcomesComplete?: boolean };
    children: { question: string; outcomeLabel: string; closeAt?: string }[];
  }, idempotencyKey: string) =>
    post<{ request: CreationRequest; accessToken?: string; replay: boolean }>('/api/creation/groups', input, { 'idempotency-key': idempotencyKey }),
  /** Reads a Polymarket page address through the backend. Nothing is written or charged. */
  previewImport: (url: string) => post<ImportPreviewResult>('/api/creation/imports/preview', { url }),
  /**
   * Creates the event and its children from a source page. A refusal — the source cannot be
   * imported, or it already was — comes back with its reasons and links attached, not bare.
   */
  createImport: async (input: { url: string; requesterKind: 'browser' | 'agent'; requester: string; positions?: number[] }, idempotencyKey: string) => {
    const response = await fetch('/api/creation/imports', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(input),
    });
    const body = await response.json() as ({ request: CreationRequest; accessToken?: string; replay: boolean } & ImportRejection);
    if (response.ok) return { ok: true as const, request: body.request, accessToken: body.accessToken, replay: body.replay };
    if (response.status === 409 || response.status === 422) {
      return { ok: false as const, reason: body.error, preview: body.preview, existing: body.existing };
    }
    throw new ApiError(response.status, body.error ?? 'import_failed');
  },
  selectChildren: (id: string, token: string, positions: number[]) =>
    post<{ request: CreationRequest }>(`/api/creation/requests/${id}/selection`, { positions }, { authorization: `Bearer ${token}` }),
  getRequest: (id: string, token: string) => request<{ request: CreationRequest }>(`/api/creation/requests/${id}`, { headers: { authorization: `Bearer ${token}` } }),
  myCreations: (requester: string) => request<{ requests: CreationSummary[] }>(`/api/creation/requests?requester=${encodeURIComponent(requester)}`),
  abandon: (id: string, token: string) => post<{ request: CreationRequest }>(`/api/creation/requests/${id}/abandonment`, {}, { authorization: `Bearer ${token}` }),
  approve: (id: string, token: string, draftHash: string) => post<{ request: CreationRequest }>(`/api/creation/requests/${id}/approval`, { draftHash }, { authorization: `Bearer ${token}` }),
  verify: (id: string, token: string, proof: unknown) => post<{ request: CreationRequest }>(`/api/creation/requests/${id}/verification`, { proof }, { authorization: `Bearer ${token}` }),
  worldContext: (id: string, token: string) => post<{ rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }>(
    `/api/creation/requests/${id}/world/rp-context`, {}, { authorization: `Bearer ${token}` }),
  requirePayment: async (id: string, token: string) => {
    const response = await fetch(`/api/creation/requests/${id}/payment`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    const body = await response.json() as { resource?: PaymentResource; accepts?: PaymentRequirements[]; request: CreationRequest; paid?: boolean; error?: string };
    if (response.status === 402) return { paid: false as const, resource: body.resource, accepts: body.accepts ?? [], request: body.request };
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'payment_failed');
    return { paid: true as const, resource: undefined, accepts: [], request: body.request };
  },
  pay: (id: string, token: string, header: string) =>
    post<{ paid: boolean; replay: boolean; request: CreationRequest }>(`/api/creation/requests/${id}/payment`, {}, { authorization: `Bearer ${token}`, 'payment-signature': header }),
  adminSession: () => request<{ authenticated: boolean; email: string | null }>('/api/admin/session'),
  adminLogin: (email: string, password: string) => post<{ authenticated: boolean; email: string }>('/api/admin/session', { email, password }),
  adminLogout: () => request<{ authenticated: boolean }>('/api/admin/session', { method: 'DELETE' }),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  adminActivity: (market?: string) => request<AdminActivity>(`/api/admin/activity${market ? `?market=${market}` : ''}`),
  adminRetry: (id: string) => post<{ requestId: string; enqueued: boolean }>(`/api/admin/requests/${id}/retry`, {}),
  adminResolve: (market: string, result: string, evidence: string) => post<{ id: string; status: string }>('/api/admin/resolutions', { market, result, evidence }),
  adminReconcile: (id: string, outcome: 'SETTLED' | 'FAILED', reference: string) => post<{ id: string; status: string }>(`/api/admin/payments/${id}/reconciliation`, { outcome, reference }),
};
