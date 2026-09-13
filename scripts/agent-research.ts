import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { ExactHederaScheme, PrivateKey, createClientHederaSigner } from '@x402/hedera';
import type { PaymentRequirements as CorePaymentRequirements, PaymentPayload } from '@x402/core/types';
import { createPublicClient, createWalletClient, http, erc20Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { PaymentRequirements, PaymentResource } from '../src/payments/x402.js';

/**
 * An autonomous research agent on Horizon. Given an operator's prompt — "collect data on X" —
 * it collects that data by running a market:
 *
 *   1. Claude turns the request into one binary market, a prior, and two resting bids;
 *   2. the agent requests the market from Horizon, Claude reviews the exact draft, the agent
 *      pays the creation fee over Hedera x402 and waits for the market on Sepolia;
 *   3. the two curves are rested from the maker wallet, inside a safe price range and a
 *      spending cap the operator sets;
 *   4. the market is watched for trades and curves from humans and other agents;
 *   5. Claude reports what the market revealed, and the run is saved under .local/.
 *
 *   npm run agent:research -- --prompt "Collect data on whether …" [--watch 5m] [--shares 10]
 *     [--max-usdc 10] [--api https://…] [--model claude-opus-5] [--market 0x…] [--resume] [--dry-run]
 *
 * ANTHROPIC_API_KEY is required. Creation needs HEDERA_AGENT_ACCOUNT_ID and
 * HEDERA_AGENT_PRIVATE_KEY; curves need EVM_DEPLOYER_PRIVATE_KEY and EVM_RPC_URL. `--market`
 * skips creation and works an existing open market; `--resume` continues the last run without
 * paying or publishing twice; `--dry-run` stops after the plan. Ctrl+C during the watch ends
 * collection early and still writes the report.
 */

// One clean line on failure instead of a stack trace; the saved run under .local/ keeps the details.
const fail = (error: unknown) => {
  const message = error instanceof Anthropic.AuthenticationError ? 'Claude rejected the API key; check ANTHROPIC_API_KEY.'
    : error instanceof Error ? error.message : String(error);
  console.error(`\n\x1b[31m✖\x1b[0m ${message}`);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

// ---------------------------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------------------------
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(name);
const durationMs = (text: string) => {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (m && (m[1] || m[2])) return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000;
  if (/^\d+$/.test(text.trim())) return Number(text) * 1000;
  throw new Error(`Bad duration "${text}"; use forms like 5m, 90s or 2m30s`);
};

const prompt = arg('--prompt');
const api = (arg('--api') || process.env.HORIZON_API_URL || 'https://horizon-production-8c50.up.railway.app').replace(/\/$/, '');
const model = arg('--model') || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const shares = Number(arg('--shares') ?? 10);
const maxUsdc = Number(arg('--max-usdc') ?? 10);
const watchMs = durationMs(arg('--watch') ?? '5m');
const intervalMs = durationMs(arg('--interval') ?? '10s');
const givenMarket = arg('--market') as Address | undefined;
const resume = flag('--resume');
const dryRun = flag('--dry-run');
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required (put it in .env or export it).');
if (!resume && !prompt) throw new Error('Usage: npm run agent:research -- --prompt "Collect data on whether …?"');
if (givenMarket && !/^0x[0-9a-fA-F]{40}$/.test(givenMarket)) throw new Error('--market must be a 0x… address');
if (!(shares >= 0) || !(maxUsdc >= 0)) throw new Error('--shares and --max-usdc must be non-negative numbers');

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------
const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => tty ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = paint('1'), dim = paint('2'), cyan = paint('36'), green = paint('32'), yellow = paint('33'), red = paint('31'), magenta = paint('35');
const stage = (n: number, title: string) => console.log(`\n${bold(cyan(`━━ ${n}/5  ${title}`))}`);
const line = (text = '') => console.log(`   ${text}`);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const pct = (micro: number | null | undefined) => micro == null ? '—' : `${(micro / 10_000).toFixed(0)}%`;
const usdc = (micro: number | string) => (Number(micro) / 1e6).toFixed(2);
const price = (value: number) => value.toFixed(2);
const clock = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Run state: everything needed to resume without paying or publishing twice.
// ---------------------------------------------------------------------------------------------
type Curve = { start: number; end: number };
type Plan = {
  goal: string; question: string; category: string; closeAt: string; probabilityYes: number; reasoning: string;
  curves: { yesBid: Curve; noBid: Curve; shape: number }; relatedMarkets: string[];
};
type Seeded = { side: 'YES' | 'NO'; start: number; end: number; shares: number; orderHash: Hex; ship: Hex; admit: Hex };
type WatchEvent = { at: string; kind: string; text: string };
type Report = { headline: string; impliedProbabilityYes: number | null; summary: string; observations: string[]; nextSteps: string[] };
type State = {
  runId: string; prompt: string; api: string; model: string; startedAt: string;
  plan?: Plan; safety?: string[];
  requestId?: string; accessToken?: string; paymentTx?: string; marketAddress?: Address; creationTxHash?: string;
  seeded?: Seeded[]; events?: WatchEvent[]; watchedMs?: number; report?: Report;
};
const stateDir = new URL('../.local/agent-research/', import.meta.url);
const stateFile = (runId: string) => new URL(`${runId}.json`, stateDir);
let state: State;
if (resume) {
  const latest = JSON.parse(await readFile(new URL('latest.json', stateDir), 'utf8')) as { runId: string };
  state = JSON.parse(await readFile(stateFile(latest.runId), 'utf8')) as State;
  console.log(`${bold('Horizon research agent')} · resuming run ${state.runId}`);
} else {
  const runId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 6)}`;
  state = { runId, prompt: prompt!, api, model, startedAt: new Date().toISOString(), ...(givenMarket ? { marketAddress: givenMarket } : {}) };
  console.log(`${bold('Horizon research agent')} · run ${runId}`);
}
line(dim(`${state.api} · ${state.model} · shares ${shares} per curve · cap ${maxUsdc} USDC · watch ${watchMs / 1000}s`));
async function save() {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile(state.runId), JSON.stringify(state, null, 2), { mode: 0o600 });
  await writeFile(new URL('latest.json', stateDir), JSON.stringify({ runId: state.runId }));
}

// ---------------------------------------------------------------------------------------------
// Horizon API
// ---------------------------------------------------------------------------------------------
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${state.api}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok && response.status !== 402) throw new Error(`${method} ${path}: ${parsed.error ?? `HTTP ${response.status}`}`);
  return { status: response.status, body: parsed };
}
type IndexedMarket = { id: Address; question: string; closeAt: number; status: 'OPEN' | 'CLOSED' | 'RESOLVED' };
type Liquidity = { yes: { ask: number | null; bid: number | null; availableShares: string }; no: { ask: number | null; bid: number | null; availableShares: string }; curves: number };
type MarketCurve = { id: Hex; maker: Address; filled: string; remaining: string; side: 'YES' | 'NO'; direction: 'BUY' | 'SELL'; strategy: { startPrice: number; endPrice: number; maxShares: string } };
type Detail = { indexedBlock: number; market: IndexedMarket & { liquidity: Liquidity; curves: MarketCurve[]; rules: string; evidenceSource: string } };
type Trade = { id: string; taker: Address; isYes: boolean; isBuy: boolean; shares: string; usdc: string; fills: number; transaction: Hex; block: number };
type Draft = { question: string; yesOutcome: string; noOutcome: string; category: string; closeAt: string; rules: string; evidenceSource: string };
type CreationRequest = {
  id: string; status: string; draft?: Draft; draftHash?: string; draftProvider?: string; draftMode?: string;
  review?: { market: string; question: string; closeAt: string; similarity: number; reason: string }[];
  marketAddress?: Address; creationTxHash?: Hex; failureCode?: string; payment?: { transactionRef?: string };
};
type Required = { x402Version: 2; resource: PaymentResource; accepts: PaymentRequirements[]; request: CreationRequest };
const market = (address: Address) => call<Detail>('GET', `/api/markets/${address}`).then(r => r.body);
const trades = (address: Address) => call<{ trades: Trade[] }>('GET', `/api/markets/${address}/trades`).then(r => r.body.trades);

// ---------------------------------------------------------------------------------------------
// Claude. One helper: a system prompt, a user message and a schema in; a validated object out.
// The refusal fallback beta is tried first; an organization without it answers 400, and the
// same call runs without it.
// ---------------------------------------------------------------------------------------------
const claude = new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 });
async function ask<T extends z.ZodType>(label: string, schema: T, system: string, user: string, effort: 'low' | 'medium' | 'high'): Promise<z.infer<T>> {
  const params = {
    model: state.model, max_tokens: 16_000, system, messages: [{ role: 'user' as const, content: user }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  };
  const started = Date.now();
  if (tty) process.stdout.write(`   ${dim(`${label}: thinking…`)}`);
  let response;
  try {
    try { response = await claude.beta.messages.parse({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }); }
    catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      response = await claude.beta.messages.parse(params);
    }
  } finally { if (tty) process.stdout.write('\r\x1b[2K'); }
  if (response.stop_reason === 'refusal') throw new Error(`${label}: the model declined (${response.stop_details?.category ?? 'unspecified'})`);
  if (!response.parsed_output) throw new Error(`${label}: the model did not return the expected JSON`);
  line(dim(`${label}: ${response.model} · ${response.usage.input_tokens} in / ${response.usage.output_tokens} out · ${((Date.now() - started) / 1000).toFixed(1)}s`));
  return response.parsed_output as z.infer<T>;
}

const HORIZON = [
  'Horizon is a fully collateralized binary YES/NO prediction market on Ethereum Sepolia with test USDC; nothing here is real money.',
  'Prices are USDC per share between 0 and 1 and read as probabilities. Each YES/NO pair is backed by exactly 1 USDC.',
  'Makers rest curves, not orders: a buy curve bids `start` for the first share and slides to `end` for the last (end ≤ start).',
  'A YES buy curve bids for YES. A NO buy curve bids for NO, which traders see as a YES ask at 1 − price, so a YES bid and a NO bid together quote a two-sided market.',
  'Trading has no fee. Creating a market is a paid service; a disclosed resolver settles YES, NO or INVALID from a named public evidence source after close.',
].join(' ');

// ---------------------------------------------------------------------------------------------
// 1. Plan: the operator's request becomes one market, a prior and two safe bids.
// ---------------------------------------------------------------------------------------------
const bidSchema = z.object({
  start: z.number().describe('USDC per share for the first share, 0.03–0.95, at most two decimals'),
  end: z.number().describe('USDC per share for the last share: 0.05 to 0.15 below start'),
});
const planSchema = z.object({
  goal: z.string().describe('What the operator wants to learn, in one sentence'),
  question: z.string().describe('The market question: 15–200 characters, one checkable claim with a specific date, ending in a question mark'),
  category: z.string().describe('2–40 characters, e.g. Crypto, Technology, Sports, Politics, Economics, Science, Culture'),
  closeAt: z.string().describe('ISO 8601 UTC close time, strictly in the future and at or before the moment the outcome becomes public'),
  probabilityYes: z.number().describe('Your honest prior that the question resolves YES, between 0.02 and 0.98'),
  reasoning: z.string().describe('Two or three sentences: why that prior, and what a trader would need to know to beat it'),
  curves: z.object({
    yesBid: bidSchema, noBid: bidSchema,
    shape: z.number().int().describe('1 moves evenly as it fills, 2 holds the start price longer, 3 longest'),
  }),
  relatedMarkets: z.array(z.string()).describe('Addresses of indexed markets on the same topic, copied from the list given; empty if none'),
});
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The safe range the agent may quote in, applied to whatever the model proposed: each bid sits
 * at least two cents under its side's fair value, slides 5–15 cents as it fills, and stays
 * inside 0.03–0.95. Because both starts sit under fair value, the YES bid and the YES ask the
 * NO bid implies never cross. Every correction is reported, never silent.
 */
function safeCurves(plan: Plan): { probabilityYes: number; curves: Plan['curves']; notes: string[] } {
  const notes: string[] = [];
  const p = Math.min(0.95, Math.max(0.05, plan.probabilityYes));
  if (p !== plan.probabilityYes) notes.push(`prior ${plan.probabilityYes} clamped to ${p}`);
  const side = (name: string, fair: number, bid: Curve): Curve => {
    let start = round2(bid.start), end = round2(bid.end);
    const ceiling = round2(fair - 0.02);
    if (!(start <= ceiling)) { notes.push(`${name} start ${price(start)} is above fair − 0.02; set to ${price(ceiling)}`); start = ceiling; }
    if (!(start >= 0.03)) { notes.push(`${name} start ${price(start)} is below 0.03; set to 0.03`); start = 0.03; }
    if (!(end <= start - 0.05) || !(end >= start - 0.15)) {
      const fixed = round2(Math.max(0.02, start - 0.08));
      notes.push(`${name} end ${price(end)} is not 0.05–0.15 under its start; set to ${price(fixed)}`); end = fixed;
    }
    return { start, end };
  };
  const shape = [1, 2, 3].includes(plan.curves.shape) ? plan.curves.shape : 1;
  if (shape !== plan.curves.shape) notes.push(`shape ${plan.curves.shape} is not 1, 2 or 3; set to 1`);
  return { probabilityYes: p, curves: { yesBid: side('YES bid', p, plan.curves.yesBid), noBid: side('NO bid', 1 - p, plan.curves.noBid), shape }, notes };
}

async function plan(): Promise<Plan> {
  const listing = await call<{ indexedBlock: number; markets: IndexedMarket[] }>('GET', '/api/markets').then(r => r.body);
  const open = listing.markets.filter(m => m.status === 'OPEN').slice(0, 60)
    .map(m => `- ${m.id} | closes ${new Date(m.closeAt * 1000).toISOString()} | ${m.question}`).join('\n') || '- (none)';
  const existing = state.marketAddress ? (await market(state.marketAddress)).market : undefined;
  const system = [
    'You are the Horizon research agent: an autonomous market maker that collects information by running a prediction market and letting humans and other agents trade against it.',
    HORIZON,
    existing
      ? 'The market already exists and is fixed: copy its question, category and close time exactly as given, then supply your prior and two bids.'
      : 'Design exactly one binary market whose price will reveal what the operator wants to know. Do not duplicate an indexed market listed below; if the topic is covered, write a distinct question and cite the related addresses.',
    `Now is ${new Date().toISOString()}.`,
    'Bids must sit in the safe range: yesBid.start ≤ probabilityYes − 0.02, noBid.start ≤ (1 − probabilityYes) − 0.02, each end 0.05–0.15 below its start, every price 0.03–0.95 with at most two decimals.',
    'Horizon writes the resolution rules and evidence wording from the question; you supply the question, category and close time only.',
  ].join(' ');
  const user = [
    `Operator request: ${state.prompt}`,
    existing ? `Fixed market ${existing.id}: "${existing.question}" · closes ${new Date(existing.closeAt * 1000).toISOString()} · rules: ${existing.rules} · evidence: ${existing.evidenceSource}` : '',
    `Indexed open markets at block ${listing.indexedBlock}:`, open,
  ].filter(Boolean).join('\n');
  const proposed = await ask('plan', planSchema, system, user, 'medium');
  if (proposed.question.trim().length < 15 || proposed.question.trim().length > 200) throw new Error(`The planned question is ${proposed.question.trim().length} characters; Horizon accepts 15–200.`);
  const closeAt = new Date(proposed.closeAt);
  if (Number.isNaN(closeAt.getTime()) || closeAt.getTime() <= Date.now() + 10 * 60_000) throw new Error(`The planned close time ${proposed.closeAt} is not at least ten minutes in the future.`);
  const result: Plan = { ...proposed, question: proposed.question.trim(), category: proposed.category.trim().slice(0, 40), closeAt: closeAt.toISOString() };
  const { probabilityYes, curves, notes } = safeCurves(result);
  result.probabilityYes = probabilityYes;
  result.curves = curves;
  state.safety = notes;
  return result;
}

stage(1, `Understanding the request (${state.model})`);
line(`${dim('Prompt')}  ${state.prompt}`);
if (!state.plan) { state.plan = await plan(); await save(); } else line(dim('plan restored from the saved run'));
const P = state.plan;
line(`${dim('Goal')}    ${P.goal}`);
line(`${dim('Market')}  ${bold(P.question)}`);
line(`${dim('Closes')}  ${P.closeAt}  ${dim('·')}  ${P.category}`);
line(`${dim('Prior')}   ${bold(`YES ${(P.probabilityYes * 100).toFixed(0)}%`)} — ${P.reasoning}`);
line(`${dim('Bids')}    YES ${price(P.curves.yesBid.start)}→${price(P.curves.yesBid.end)} ×${shares}   NO ${price(P.curves.noBid.start)}→${price(P.curves.noBid.end)} ×${shares}  ${dim(`(YES ask ${price(1 - P.curves.noBid.start)}, shape ${P.curves.shape})`)}`);
line(state.safety?.length ? yellow(`Safe range applied: ${state.safety.join('; ')}`) : green('Safe range ✓ both bids under fair value, never crossing'));
if (P.relatedMarkets.length) line(dim(`Related indexed markets: ${P.relatedMarkets.join(', ')}`));
if (dryRun) { line(dim(`Dry run: nothing created or published. Saved ${stateFile(state.runId).pathname}`)); process.exit(0); }

// ---------------------------------------------------------------------------------------------
// 2. Create: request, review the exact draft, pay over Hedera x402, wait for Sepolia.
// ---------------------------------------------------------------------------------------------
const reviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().describe('One or two sentences'),
  reuseMarket: z.string().nullable().describe('If rejecting because an indexed market in the review list asks the same question and is still open, its address; otherwise null'),
});

async function createMarket(): Promise<Address> {
  const accountId = process.env.HEDERA_AGENT_ACCOUNT_ID, privateKey = process.env.HEDERA_AGENT_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error('HEDERA_AGENT_ACCOUNT_ID and HEDERA_AGENT_PRIVATE_KEY are required to pay for creation (or pass --market 0x…).');
  let current: CreationRequest;
  if (!state.requestId) {
    const created = await call<{ request: CreationRequest; accessToken?: string }>('POST', '/api/creation/requests', {
      question: P.question, requesterKind: 'agent', requester: `agent:${accountId}`, closeAt: P.closeAt, category: P.category,
    }, { 'idempotency-key': randomUUID() });
    if (!created.body.accessToken) throw new Error('The API did not return an access token for the new request.');
    state.requestId = created.body.request.id; state.accessToken = created.body.accessToken; await save();
    current = created.body.request;
  } else {
    current = (await call<{ request: CreationRequest }>('GET', `/api/creation/requests/${state.requestId}`, undefined, { authorization: `Bearer ${state.accessToken}` })).body.request;
    line(dim(`request ${current.id} restored · ${current.status}`));
  }
  const auth = { authorization: `Bearer ${state.accessToken}` };
  line(`${dim('Request')} ${current.id} ${dim(`· drafted by ${current.draftProvider ?? '?'} (${current.draftMode ?? '?'})`)}`);

  if (current.status === 'DRAFT') {
    const draft = current.draft;
    if (!draft || !current.draftHash) throw new Error('The request has no reviewable draft.');
    line(`${dim('Draft')}   ${draft.question}  ${dim(`· ${draft.yesOutcome}/${draft.noOutcome} · closes ${draft.closeAt}`)}`);
    line(dim(`Rules   ${draft.rules.slice(0, 160)}${draft.rules.length > 160 ? '…' : ''}`));
    for (const warning of current.review ?? []) line(yellow(`Duplicate warning: ${warning.market} "${warning.question}" (${Math.round(warning.similarity * 100)}%)`));
    const review = await ask('review', reviewSchema, [
      'You are the Horizon research agent reviewing the exact market draft Horizon produced from your request, before paying for it. Horizon normalizes wording and writes the rules; that is expected.',
      HORIZON,
      'Approve when the draft asks the question you intended, the close time is acceptable and the rules resolve from public evidence.',
      'Reject only for a material problem: the wrong question, an undecidable or contradictory rule, a close time that makes the question meaningless, or a listed duplicate that asks the same question and is still open — then name it in reuseMarket.',
    ].join(' '), [
      `Operator goal: ${P.goal}`, `Intended question: ${P.question} · close ${P.closeAt}`,
      `Draft: ${JSON.stringify(draft)}`, `Duplicate review: ${JSON.stringify(current.review ?? [])}`,
    ].join('\n'), 'low');
    if (review.decision !== 'approve') {
      line(red(`Agent review: REJECT — ${review.reason}`));
      await call('POST', `/api/creation/requests/${current.id}/abandonment`, {}, auth).catch(() => undefined);
      delete state.requestId; delete state.accessToken; await save();
      if (review.reuseMarket && /^0x[0-9a-fA-F]{40}$/.test(review.reuseMarket)) {
        line(yellow(`Using the existing market ${review.reuseMarket} instead of paying for a duplicate.`));
        return review.reuseMarket as Address;
      }
      throw new Error('The draft was rejected; nothing was paid. Rephrase the prompt and run again.');
    }
    line(green(`Agent review: APPROVE — ${review.reason}`));
    current = (await call<{ request: CreationRequest }>('POST', `/api/creation/requests/${current.id}/approval`, { draftHash: current.draftHash }, auth)).body.request;
  }

  if (['APPROVED', 'PAYMENT_REQUIRED'].includes(current.status)) {
    const issued = await call<Required>('POST', `/api/creation/requests/${current.id}/payment`, {}, auth);
    if (issued.status !== 402 || issued.body.x402Version !== 2 || issued.body.accepts?.length !== 1) throw new Error('The API did not return one x402 v2 payment requirement.');
    const requirements = issued.body.accepts[0]!;
    if (requirements.network !== 'hedera:testnet' || requirements.asset !== '0.0.0' || !requirements.extra.feePayer) throw new Error('The API returned unsupported Hedera payment requirements.');
    line(`${dim('Price')}   ${(Number(requirements.amount) / 1e8).toFixed(2)} HBAR on ${requirements.network} ${dim('· x402 exact scheme')}`);
    // The hackathon agent account is ECDSA; the SDK's untagged fromString() would sign as ED25519.
    const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(privateKey), { network: requirements.network });
    const partial = await new ExactHederaScheme(signer).createPaymentPayload(2, requirements as CorePaymentRequirements);
    const payload: PaymentPayload = { ...partial, resource: issued.body.resource, accepted: requirements as CorePaymentRequirements };
    const paid = await call<{ request: CreationRequest }>('POST', `/api/creation/requests/${current.id}/payment`, {}, {
      ...auth, 'payment-signature': Buffer.from(JSON.stringify(payload)).toString('base64'),
    });
    current = paid.body.request;
    const tx = current.payment?.transactionRef;
    state.paymentTx = tx; await save();
    const hashscan = tx && /^\d+\.\d+\.\d+@\d+\.\d+$/.test(tx) ? `https://hashscan.io/testnet/transaction/${tx.replace('@', '-').replace(/(\d+)\.(\d+)$/, '$1-$2')}` : undefined;
    line(green(`Paid · ${current.status}`) + (tx ? `  ${dim(tx)}` : ''));
    if (hashscan) line(dim(hashscan));
  }
  if (current.status === 'PAYMENT_REVIEW') throw new Error('The payment needs operator reconciliation; another payment will not be attempted.');

  process.stdout.write(`   ${dim('Waiting for the worker to deploy the market on Sepolia')}`);
  for (let attempt = 0; attempt < 150 && ['PAID', 'CREATING'].includes(current.status); attempt++) {
    await sleep(2_000);
    process.stdout.write(dim('.'));
    current = (await call<{ request: CreationRequest }>('GET', `/api/creation/requests/${current.id}`, undefined, auth)).body.request;
  }
  process.stdout.write('\n');
  if (current.status !== 'CREATED' || !current.marketAddress) throw new Error(`Creation ended in ${current.status}${current.failureCode ? ` (${current.failureCode})` : ''}; rerun with --resume once it is CREATED.`);
  state.creationTxHash = current.creationTxHash;
  return current.marketAddress;
}

stage(2, 'Creating the market on Horizon');
if (state.marketAddress) line(dim(`using market ${state.marketAddress}`));
else { state.marketAddress = await createMarket(); await save(); }
const MARKET = state.marketAddress;
line(`${green('Market')}  ${bold(MARKET)}` + (state.creationTxHash ? `  ${dim(`tx ${state.creationTxHash}`)}` : ''));
line(bold(`${state.api}/markets/${MARKET}`));

// ---------------------------------------------------------------------------------------------
// 3. Seed: two curves through the same endpoint the trade ticket uses.
// ---------------------------------------------------------------------------------------------
type Prepared = {
  orderHash: Hex; readiness: 'ready' | 'approval_required' | 'insufficient_balance' | 'over_budget';
  budget: { requested: string; required: string; shortfall: string };
  approval: { token: Address; spender: Address; amount: string };
  transaction: { to: Address; data: Hex }; admission: { to: Address; data: Hex };
};
const micro = (value: number) => Math.round(value * 1_000_000);

async function seed(): Promise<Seeded[]> {
  const raw = process.env.EVM_DEPLOYER_PRIVATE_KEY;
  if (!raw || !process.env.EVM_RPC_URL) throw new Error('EVM_DEPLOYER_PRIVATE_KEY and EVM_RPC_URL are required to publish curves (or pass --shares 0).');
  const maker = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
  const chain = createPublicClient({ chain: sepolia, transport: http(process.env.EVM_RPC_URL) });
  const wallet = createWalletClient({ account: maker, chain: sepolia, transport: http(process.env.EVM_RPC_URL, { retryCount: 0 }) });
  if (await chain.getChainId() !== 11155111) throw new Error('EVM_RPC_URL is not Sepolia');
  const send = async (label: string, tx: { to: Address; data: Hex }) => {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
    const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    line(dim(`${label.padEnd(22)} ${hash}`));
    return hash;
  };
  line(`${dim('Maker')}   ${maker.address}`);
  const done: Seeded[] = state.seeded ?? [];
  let committed = done.reduce((sum, curve) => sum + curve.shares * curve.start, 0);
  const wanted: { side: 'YES' | 'NO'; bid: Curve }[] = [{ side: 'YES', bid: P.curves.yesBid }, { side: 'NO', bid: P.curves.noBid }];
  for (const { side, bid } of wanted) {
    if (done.some(curve => curve.side === side)) { line(dim(`${side} bid already published in this run`)); continue; }
    const body = { maker: maker.address, market: MARKET, isYes: side === 'YES', isBuy: true, startPrice: micro(bid.start), endPrice: micro(bid.end), shares: String(micro(shares)), shape: P.curves.shape };
    const prepared = (await call<Prepared>('POST', '/api/curves', body)).body;
    const needs = Number(prepared.budget.requested) / 1e6;
    line(`${bold(`${side} bid`)} ${price(bid.start)}→${price(bid.end)} ×${shares} ${dim(`· needs ${needs.toFixed(2)} USDC · ${prepared.readiness}`)}`);
    if (committed + needs > maxUsdc) throw new Error(`Publishing this curve would commit ${(committed + needs).toFixed(2)} USDC, above the ${maxUsdc} USDC cap (--max-usdc).`);
    if (prepared.readiness === 'insufficient_balance' || prepared.readiness === 'over_budget') throw new Error(`The maker wallet cannot fund this order (short ${usdc(prepared.budget.shortfall)} USDC); fund it or lower --shares.`);
    if (prepared.readiness === 'approval_required') {
      const hash = await wallet.writeContract({ address: prepared.approval.token, abi: erc20Abi, functionName: 'approve', args: [prepared.approval.spender, BigInt(prepared.approval.amount)] });
      await chain.waitForTransactionReceipt({ hash, timeout: 180_000 });
      line(dim(`approve USDC for Aqua    ${hash}`));
    }
    const ship = await send('ship (Aqua)', prepared.transaction);
    const admit = await send('admitCurve (router)', prepared.admission);
    done.push({ side, start: bid.start, end: bid.end, shares, orderHash: prepared.orderHash, ship, admit });
    committed += needs;
    state.seeded = done; await save();
  }
  line(green(`Two curves resting · ${committed.toFixed(2)} USDC committed of the ${maxUsdc} USDC cap`));
  return done;
}

stage(3, 'Seeding two curves from the maker wallet');
if (shares === 0) line(dim('--shares 0: nothing published'));
else if (state.seeded?.length === 2) line(dim('both curves already published in this run'));
else await seed();
const OURS = new Set((state.seeded ?? []).map(curve => curve.orderHash.toLowerCase()));

// ---------------------------------------------------------------------------------------------
// 4. Watch: trades and curves from anyone but us, until the clock or Ctrl+C.
// ---------------------------------------------------------------------------------------------
const implied = (liquidity: Liquidity, last?: Trade): number | null => {
  const { bid, ask } = liquidity.yes;
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (last) { const paid = Number(last.usdc) / Number(last.shares) * 1e6; return last.isYes ? paid : 1_000_000 - paid; }
  return bid ?? ask;
};

async function watch(): Promise<{ detail: Detail; trades: Trade[] }> {
  const events = state.events ?? [];
  const record = async (kind: string, text: string) => {
    events.push({ at: new Date().toISOString(), kind, text: text.replace(/\x1b\[[0-9;]*m/g, '') });
    line(`${dim(clock())} ${kind.padEnd(6)} ${text}`);
    state.events = events; await save();
  };
  const seenTrades = new Set<string>(), seenFills = new Map<string, string>();
  let lastBook = '', lastDetail!: Detail, lastTrades: Trade[] = [];
  let stop = false, first = true;
  // A terminal Ctrl+C reaches the process twice under `npm run` — once from the terminal, once
  // forwarded by npm — so the handler stays registered and the second signal is a no-op.
  const onInterrupt = () => { if (!stop) line(yellow('Ending collection early…')); stop = true; };
  process.on('SIGINT', onInterrupt);
  const started = Date.now();
  let heartbeat = started;
  while (!stop) {
    const [detail, history] = await Promise.all([market(MARKET), trades(MARKET)]);
    lastDetail = detail; lastTrades = history;
    const m = detail.market;
    const book = `YES bid ${pct(m.liquidity.yes.bid)} · YES ask ${pct(m.liquidity.yes.ask)} · ${m.liquidity.curves} curves`;
    if (book !== lastBook) { await record(first ? 'START' : 'BOOK', `${book} ${dim(`· implied YES ${pct(implied(m.liquidity, history[0]))}`)}`); lastBook = book; }
    for (const trade of [...history].reverse()) {
      if (seenTrades.has(trade.id)) continue;
      seenTrades.add(trade.id);
      if (first) continue;  // what was already there is counted once, below, not replayed
      const each = Number(trade.usdc) / Number(trade.shares);
      await record('TRADE', `${short(trade.taker)} ${trade.isBuy ? 'bought' : 'sold'} ${usdc(trade.shares)} ${trade.isYes ? 'YES' : 'NO'} for ${usdc(trade.usdc)} USDC ${dim(`(${each.toFixed(2)}/share, ${trade.fills} fill${trade.fills === 1 ? '' : 's'}, tx ${short(trade.transaction)})`)}`);
    }
    for (const curve of m.curves) {
      const previous = seenFills.get(curve.id.toLowerCase());
      seenFills.set(curve.id.toLowerCase(), curve.filled);
      const ours = OURS.has(curve.id.toLowerCase());
      if (previous === undefined && !first && !ours) {
        await record('CURVE', `${short(curve.maker)} rested ${curve.direction} ${curve.side} ${usdc(curve.strategy.startPrice)}→${usdc(curve.strategy.endPrice)} ×${usdc(curve.strategy.maxShares)}`);
      } else if (previous !== undefined && previous !== curve.filled && ours) {
        await record('FILL', `our ${curve.side} bid filled ${usdc(curve.filled)}/${usdc(curve.strategy.maxShares)} shares`);
      }
    }
    if (first) {
      const others = m.curves.filter(curve => !OURS.has(curve.id.toLowerCase())).length;
      if (others || history.length) await record('NOTE', `${history.length} earlier trade${history.length === 1 ? '' : 's'} and ${others} curve${others === 1 ? '' : 's'} from others were already on this market`);
      first = false;
    }
    if (m.status !== 'OPEN') { await record('CLOSE', `market is ${m.status}`); break; }
    if (Date.now() - started >= watchMs) break;
    if (Date.now() - heartbeat >= 60_000) { line(dim(`${clock()} …      still watching (${Math.round((Date.now() - started) / 1000)}s), Ctrl+C to report now`)); heartbeat = Date.now(); }
    for (let waited = 0; waited < intervalMs && !stop; waited += 250) await sleep(250);
  }
  process.off('SIGINT', onInterrupt);
  state.watchedMs = (state.watchedMs ?? 0) + (Date.now() - started); await save();
  return { detail: lastDetail, trades: lastTrades };
}

stage(4, `Collecting data — watching ${short(MARKET)} for ${Math.round(watchMs / 1000)}s ${dim('(Ctrl+C to report now)')}`);
const observed = watchMs > 0 ? await watch() : { detail: await market(MARKET), trades: await trades(MARKET) };

// ---------------------------------------------------------------------------------------------
// 5. Report: what the market said.
// ---------------------------------------------------------------------------------------------
const reportSchema = z.object({
  headline: z.string().describe('One line: what the market revealed, or that it is still waiting for participants'),
  impliedProbabilityYes: z.number().nullable().describe('The probability the market currently implies from bids, asks and trades, 0–1; null if only the agent\'s own curves exist and nobody traded'),
  summary: z.string().describe('Three to six sentences comparing the market signal with the prior, who participated, and how much to trust it'),
  observations: z.array(z.string()).describe('Up to six factual bullet points from the timeline'),
  nextSteps: z.array(z.string()).describe('Up to four concrete actions: adjust curves, wait longer, resolve, ask a human'),
});

stage(5, `Findings (${state.model})`);
const final = observed.detail.market;
const takers = new Set(observed.trades.map(trade => trade.taker.toLowerCase()));
const makers = new Set(final.curves.filter(curve => !OURS.has(curve.id.toLowerCase())).map(curve => curve.maker.toLowerCase()));
const report = await ask('report', reportSchema, [
  'You are the Horizon research agent writing up what a market you created and seeded has revealed so far. Be factual and brief; never invent participants or trades.',
  HORIZON,
  'Your own curves are not evidence about the world — they are the prior you posted. Signal comes only from other makers and from trades.',
].join(' '), [
  `Operator goal: ${P.goal}`, `Question: ${final.question} · closes ${new Date(final.closeAt * 1000).toISOString()} · status ${final.status}`,
  `Agent prior: YES ${P.probabilityYes} — ${P.reasoning}`,
  `Agent curves: ${JSON.stringify(state.seeded ?? [])}`,
  `Watched for ${Math.round((state.watchedMs ?? 0) / 1000)} seconds. Timeline (${(state.events ?? []).length} entries):`,
  ...(state.events ?? []).slice(-120).map(event => `${event.at} ${event.kind} ${event.text}`),
  `Final liquidity (micro-USDC, 1000000 = 1 USDC): ${JSON.stringify(final.liquidity)}`,
  `Curves now resting: ${JSON.stringify(final.curves.map(curve => ({ maker: curve.maker, ours: OURS.has(curve.id.toLowerCase()), side: curve.side, direction: curve.direction, start: curve.strategy.startPrice, end: curve.strategy.endPrice, filled: curve.filled, remaining: curve.remaining })))}`,
  `Trades (${observed.trades.length}, ${takers.size} distinct takers): ${JSON.stringify(observed.trades.slice(0, 50))}`,
  `Other makers: ${makers.size}`,
].join('\n'), 'medium');
state.report = report; await save();

console.log();
line(bold(magenta(report.headline)));
line(`${dim('Prior')}   YES ${(P.probabilityYes * 100).toFixed(0)}%   ${dim('Market')}  ${report.impliedProbabilityYes == null ? dim('no external signal yet') : bold(`YES ${(report.impliedProbabilityYes * 100).toFixed(0)}%`)}   ${dim(`${observed.trades.length} trades · ${takers.size} takers · ${makers.size} other makers`)}`);
console.log();
for (const sentence of report.summary.split(/(?<=[.!?])\s+/)) line(sentence);
if (report.observations.length) { console.log(); for (const item of report.observations) line(`${cyan('•')} ${item}`); }
if (report.nextSteps.length) { console.log(); line(dim('Next steps')); for (const item of report.nextSteps) line(`${green('→')} ${item}`); }
console.log();
line(dim(`Market  ${state.api}/markets/${MARKET}`));
line(dim(`Saved   ${stateFile(state.runId).pathname}`));
