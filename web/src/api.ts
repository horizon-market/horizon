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
  ai: { provider: string; mode: 'live' | 'development' };
  world: { available: boolean; widgetAvailable: boolean; access: string; reason: string; action: string; appId: string; rpId: string; environment: 'sandbox' | 'staging' | 'production' };
  resolution: { centralized: boolean; disclosed: boolean; resolver: string | null; invalidPayout: string; note: string };
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
export type MarketList = { indexedBlock: number; indexedHash: string; fees: Fees; markets: Market[] };
export type Quote = {
  chainId: number; market: string; shares: string; usdc: string; limit: string; deadline: number; fees: Fees;
  simulation: 'passed' | 'approval_required' | 'insufficient_balance';
  snapshot: { block: string; hash: string; indexedBlock: number; indexedHash: string };
  search: { candidateLimit: number; fillLimit: number; method: string };
  approval: { token: string; spender: string; amount: string };
  transaction: { to: string; data: string; value: string };
  legs: { maker: string; shares: string; expectedFilled: string }[];
};
export type Publication = {
  strategy: { market: string; flags: number; startPrice: number; endPrice: number; maxShares: string; salt: string };
  orderHash: string; outcomeToken: string; tokens: string[]; amounts: string[]; shared: string;
  readiness: 'ready' | 'approval_required' | 'insufficient_balance';
  approval: { token: string; spender: string; amount: string };
  transaction: { to: string; data: string; value: string }; fees: Fees;
};
export type MakerCurve = {
  orderHash: string; market: string; question: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL';
  shape: number; startPrice: number; endPrice: number; isLimit: boolean;
  maxShares: string; filled: string; remaining: string; active: boolean; publishedAt: number; closeAt: number;
  outcomeToken: string; marketStatus: 'OPEN' | 'CLOSED' | 'RESOLVED'; cancellable: boolean;
};
export type Position = { market: string; question: string; closeAt: number; status: string; result: string; yesToken: string; noToken: string; yes: string; no: string; redeemableUsdc: string };
export type Redemption = { result: string; payoutUsdc: string; transaction: { to: string; data: string; value: string } };
export type CreationRequest = {
  id: string; status: string; question: string; requesterKind: string; requester: string;
  draft: { question: string; yesOutcome: string; noOutcome: string; category: string; closeAt: string; rules: string; evidenceSource: string } | null;
  draftHash: string | null; draftProvider: string | null; draftMode: string | null;
  review: { duplicateCheck: string; groundedOnBlock: number; rationale: string; warnings: { market: string; question: string; closeAt: string; similarity: number; reason: string }[] } | null;
  approvedAt: string | null; approvedHash: string | null; discountBps: number; discountNote: string; priceUnits: string;
  marketAddress: string | null; creationTxHash: string | null; failureCode: string | null; attempts: number;
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
  marketsError?: string;
  resolverModel: { centralized: boolean; disclosed: boolean; resolver: string | null; payouts: Record<string, string> };
};

const post = <T>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });

export const api = {
  config: () => request<AppConfig>('/api/config'),
  markets: () => request<MarketList>('/api/markets'),
  market: (id: string) => request<{ indexedBlock: number; market: Market; book: MarketBook }>(`/api/markets/${id}`),
  positions: (account: string) => request<{ indexedBlock: number; positions: Position[] }>(`/api/positions/${account}`),
  makerCurves: (account: string) => request<{ indexedBlock: number; curves: MakerCurve[] }>(`/api/curves/${account}`),
  quote: (input: { market: string; account: string; recipient: string; isYes: boolean; isBuy: boolean; shares: string; slippageBps: number }) => post<Quote>('/api/quotes', input),
  publishCurve: (input: { maker: string; market: string; isYes: boolean; isBuy: boolean; startPrice: number; endPrice: number; shares: string; shape: number }) => post<Publication>('/api/curves', input),
  cancelCurve: (input: { maker: string; market: string; orderHash: string; outcomeToken: string }) => post<{ transaction: { to: string; data: string; value: string } }>('/api/curves/cancellations', input),
  redeem: (input: { account: string; market: string; recipient: string; yesShares: string; noShares: string }) => post<Redemption>('/api/redemptions', input),
  createDraft: (input: { question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string }, idempotencyKey: string) =>
    post<{ request: CreationRequest; accessToken?: string; replay: boolean }>('/api/creation/requests', input, { 'idempotency-key': idempotencyKey }),
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
