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
  creation: { available: boolean; priceUnits: string; discountBps: number; asset: string; assetDecimals: number; network: string; settlementMode: 'live' | 'simulated'; facilitator: string; note: string };
  ai: { provider: string; mode: 'live' | 'development' };
  world: { available: boolean; access: string; reason: string; action: string; appId: string };
  resolution: { centralized: boolean; disclosed: boolean; resolver: string | null; invalidPayout: string; note: string };
};
export type SideLiquidity = { ask: number | null; bid: number | null; availableShares: string };
export type Curve = { id: string; maker: string; filled: string; strategy: { market: string; flags: number; startPrice: number; endPrice: number; maxShares: string; salt: string } };
export type Market = {
  id: string; question: string; rules: string; evidenceSource: string; closeAt: number; resolver: string;
  yesToken: string; noToken: string; result: number; resolutionEvidence: string; collateral: string; createdAt: number;
  status: 'OPEN' | 'CLOSED' | 'RESOLVED'; liquidity: { yes: SideLiquidity; no: SideLiquidity; curves: number }; curves: Curve[];
};
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
export type PaymentRequirements = { scheme: string; network: string; maxAmountRequired: string; resource: string; description: string; payTo: string; maxTimeoutSeconds: number; asset: string; extra: { nonce: string; assetDecimals: number; settlementMode: string } };
export type AdminOverview = {
  counts: Record<string, number>;
  requests: { id: string; status: string; question: string; requesterKind: string; requester: string; draftProvider: string | null; draftMode: string | null; discountBps: number; discountNote: string; priceUnits: string; marketAddress: string | null; creationTxHash: string | null; failureCode: string | null; attempts: number; createdAt: string; verified: boolean; paymentStatus: string | null }[];
  payments: { id: string; requestId: string; status: string; amountUnits: string; asset: string; facilitator: string; transactionRef: string | null; failureCode: string | null; attempts: number; createdAt: string }[];
  resolutions: { id: string; market: string; result: string; status: string; evidence: string; txHash: string | null; failureCode: string | null; attempts: number; createdAt: string }[];
  jobs: { id: string; label: string; completedAt: string }[];
  awaitingResolution: { market: string; question: string; closeAt: number; resolver: string; rules: string; evidenceSource: string; collateral: string }[];
  marketsError?: string;
  resolverModel: { centralized: boolean; disclosed: boolean; resolver: string | null; payouts: Record<string, string> };
};

const post = <T>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });

export const api = {
  config: () => request<AppConfig>('/api/config'),
  markets: () => request<MarketList>('/api/markets'),
  market: (id: string) => request<{ indexedBlock: number; market: Market }>(`/api/markets/${id}`),
  positions: (account: string) => request<{ indexedBlock: number; positions: Position[] }>(`/api/positions/${account}`),
  quote: (input: { market: string; account: string; recipient: string; isYes: boolean; isBuy: boolean; shares: string; slippageBps: number }) => post<Quote>('/api/quotes', input),
  publishCurve: (input: { maker: string; market: string; isYes: boolean; isBuy: boolean; startPrice: number; endPrice: number; shares: string; shape: number }) => post<Publication>('/api/curves', input),
  cancelCurve: (input: { maker: string; market: string; orderHash: string; outcomeToken: string }) => post<{ transaction: { to: string; data: string; value: string } }>('/api/curves/cancellations', input),
  redeem: (input: { account: string; market: string; recipient: string; yesShares: string; noShares: string }) => post<Redemption>('/api/redemptions', input),
  createDraft: (input: { question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string }, idempotencyKey: string) =>
    post<{ request: CreationRequest; accessToken?: string; replay: boolean }>('/api/creation/requests', input, { 'idempotency-key': idempotencyKey }),
  getRequest: (id: string, token: string) => request<{ request: CreationRequest }>(`/api/creation/requests/${id}`, { headers: { authorization: `Bearer ${token}` } }),
  approve: (id: string, token: string, draftHash: string) => post<{ request: CreationRequest }>(`/api/creation/requests/${id}/approval`, { draftHash }, { authorization: `Bearer ${token}` }),
  verify: (id: string, token: string, proof: unknown) => post<{ request: CreationRequest }>(`/api/creation/requests/${id}/verification`, { proof }, { authorization: `Bearer ${token}` }),
  requirePayment: async (id: string, token: string) => {
    const response = await fetch(`/api/creation/requests/${id}/payment`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    const body = await response.json() as { accepts?: PaymentRequirements[]; request: CreationRequest; paid?: boolean; error?: string };
    if (response.status === 402) return { paid: false as const, accepts: body.accepts ?? [], request: body.request };
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'payment_failed');
    return { paid: true as const, accepts: [], request: body.request };
  },
  pay: (id: string, token: string, header: string) =>
    post<{ paid: boolean; replay: boolean; request: CreationRequest }>(`/api/creation/requests/${id}/payment`, {}, { authorization: `Bearer ${token}`, 'x-payment': header }),
  adminSession: () => request<{ authenticated: boolean; email: string | null }>('/api/admin/session'),
  adminLogin: (email: string, password: string) => post<{ authenticated: boolean; email: string }>('/api/admin/session', { email, password }),
  adminLogout: () => request<{ authenticated: boolean }>('/api/admin/session', { method: 'DELETE' }),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  adminRetry: (id: string) => post<{ requestId: string; enqueued: boolean }>(`/api/admin/requests/${id}/retry`, {}),
  adminResolve: (market: string, result: string, evidence: string) => post<{ id: string; status: string }>('/api/admin/resolutions', { market, result, evidence }),
  adminReconcile: (id: string, outcome: 'SETTLED' | 'FAILED', reference: string) => post<{ id: string; status: string }>(`/api/admin/payments/${id}/reconciliation`, { outcome, reference }),
};
