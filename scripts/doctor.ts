import { z } from 'zod';
import { keccak256, toHex, type Hex } from 'viem';
import { readFile } from 'node:fs/promises';

type Check = { name: string; status: 'ok' | 'pending' | 'failed'; detail: string };
type Phase3Evidence = {
  requestId: string; requesterKind: string; status: string;
  payment: { amountUnits: string; transaction: string; result: string };
  creation: { market: string; transaction: string };
  indexing: { indexedBlock: number; marketFound: boolean };
};
const checks: Check[] = [];
const env = process.env;
const report = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });
let phase3Evidence: Phase3Evidence | undefined;
try { phase3Evidence = JSON.parse(await readFile('deployments/phase3-agent-evidence.json', 'utf8')) as Phase3Evidence; }
catch { /* A fresh checkout has no live Phase 3 evidence yet. */ }
type AuditEvidence = {
  network: string; topicId: string; requestId: string;
  events: { sequence: number; type: string; eventId: string; status: string; sequenceNumber: string | null; mirrorMatches: boolean }[];
};
let auditEvidence: AuditEvidence | undefined;
try { auditEvidence = JSON.parse(await readFile('deployments/audit-evidence.json', 'utf8')) as AuditEvidence; }
catch { /* No audit statement has been published and recorded yet. */ }

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function check(name: string, run: () => Promise<string>) {
  try { report(name, 'ok', await run()); }
  catch { report(name, 'failed', 'Check failed; verify configuration and connectivity. No secret URL or response logged.'); }
}
async function rpc(method: string, params: unknown[]): Promise<string> {
  const reply = z.object({ result: z.string() }).parse(await json(env.EVM_RPC_URL!, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  return reply.result;
}

if (env.EVM_RPC_URL) {
  await check('Sepolia chain and contracts', async () => {
    const chainId = BigInt(await rpc('eth_chainId', []));
    if (chainId !== 11155111n || chainId !== BigInt(env.EVM_CHAIN_ID ?? '11155111')) throw new Error('Wrong chain');
    for (const key of ['AQUA_ADDRESS', 'USDC_ADDRESS'] as const) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(env[key] ?? '')) throw new Error('Missing contract address');
      if (await rpc('eth_getCode', [env[key], 'latest']) === '0x') throw new Error('No code');
    }
    const decimals = await rpc('eth_call', [{ to: env.USDC_ADDRESS, data: '0x313ce567' }, 'latest']);
    if (BigInt(decimals) !== 6n) throw new Error('Unexpected USDC decimals');
    const proof = JSON.parse(await readFile('deployments/aqua-verification.json', 'utf8')) as { address: string; runtimeHash: string };
    const aquaCode = await rpc('eth_getCode', [env.AQUA_ADDRESS, 'latest']);
    if (env.AQUA_ADDRESS!.toLowerCase() !== proof.address.toLowerCase() || keccak256(aquaCode as Hex) !== proof.runtimeHash) throw new Error('Aqua identity mismatch');
    return 'Sepolia ID, six-decimal USDC and Aqua runtime hash checked against the recorded exact-source verification.';
  });
  if (env.EVM_DEPLOYER_ADDRESS) await check('Deployer funding', async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(env.EVM_DEPLOYER_ADDRESS!)) throw new Error('Invalid address');
    const gas = BigInt(await rpc('eth_getBalance', [env.EVM_DEPLOYER_ADDRESS, 'latest']));
    const usdc = BigInt(await rpc('eth_call', [{ to: env.USDC_ADDRESS, data: `0x70a08231${env.EVM_DEPLOYER_ADDRESS!.slice(2).padStart(64, '0')}` }, 'latest']));
    if (gas === 0n || usdc === 0n) throw new Error('Funding missing');
    return 'Positive ETH and test USDC balances. This read-only check does not estimate gas for future transactions.';
  });
  else report('Deployer funding', 'pending', 'Set EVM_DEPLOYER_ADDRESS after funding.');
} else report('Sepolia', 'pending', 'Set EVM_RPC_URL and funded deployer address.');

await check('Blocky402 capabilities', async () => {
  const url = new URL('/supported', env.HEDERA_FACILITATOR_URL || 'https://api.testnet.blocky402.com');
  const supported = z.object({ kinds: z.array(z.object({ scheme: z.string(), network: z.string(), x402Version: z.number() })) }).parse(await json(url.toString()));
  if (!supported.kinds.some(k => k.scheme === 'exact' && k.network === (env.HEDERA_NETWORK || 'hedera:testnet') && k.x402Version === 2)) throw new Error('No expected scheme');
  return 'Facilitator advertises exact Hedera testnet x402 v2. This does not prove settlement.';
});
if (phase3Evidence && env.HEDERA_RECEIVER_ACCOUNT_ID) await check('Hedera agent paid request', async () => {
  const transactionId = phase3Evidence!.payment.transaction.replace('@', '-').replace(/\.(\d+)$/, '-$1');
  const reply = z.object({ transactions: z.array(z.object({
    result: z.string(), transaction_id: z.string(),
    transfers: z.array(z.object({ account: z.string(), amount: z.number() })),
  })) }).parse(await json(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${transactionId}`));
  const transaction = reply.transactions[0];
  const received = transaction?.transfers.find(transfer => transfer.account === env.HEDERA_RECEIVER_ACCOUNT_ID)?.amount;
  if (!transaction || transaction.result !== 'SUCCESS' || received?.toString() !== phase3Evidence!.payment.amountUnits) throw new Error('Payment evidence mismatch');
  return `Agent x402 payment settled on Hedera testnet and transferred ${phase3Evidence.payment.amountUnits} tinybar to the configured receiver.`;
});
else report('Hedera agent paid request', 'pending', 'Run and record one real agent-owned Blocky402 settlement.');
report('Hedera browser paid request', 'pending', 'The WalletConnect client is implemented; complete and record one real browser-wallet settlement.');

if (env.GRAPH_QUERY_URL) await check('Graph query endpoint', async () => {
  const reply = z.object({ data: z.object({ _meta: z.object({ block: z.object({ number: z.number() }), hasIndexingErrors: z.boolean() }) }) }).parse(await json(env.GRAPH_QUERY_URL!, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(env.GRAPH_API_KEY ? { authorization: `Bearer ${env.GRAPH_API_KEY}` } : {}) },
    body: JSON.stringify({ query: '{ _meta { block { number } hasIndexingErrors } markets(first: 1) { id } strategies(first: 1) { id } routes(first: 1) { id } }' }),
  }));
  if (reply.data._meta.hasIndexingErrors) throw new Error('Indexing errors');
  return `Live Horizon market/strategy/route query succeeded at indexed block ${reply.data._meta.block.number}.`;
});
else report('Graph', 'pending', 'Studio/deploy access and live Horizon query endpoint needed after contracts emit events.');

if (env.GRAPH_QUERY_URL && phase3Evidence?.creation.market) await check('Graph-indexed agent market', async () => {
  const reply = z.object({ data: z.object({ market: z.object({ id: z.string(), question: z.string() }).nullable(), _meta: z.object({ block: z.object({ number: z.number() }) }) }) })
    .parse(await json(env.GRAPH_QUERY_URL!, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(env.GRAPH_API_KEY ? { authorization: `Bearer ${env.GRAPH_API_KEY}` } : {}) },
      body: JSON.stringify({ query: 'query Phase3Market($id: ID!) { market(id: $id) { id question } _meta { block { number } } }', variables: { id: phase3Evidence.creation.market.toLowerCase() } }),
    }));
  if (!reply.data.market || reply.data.market.id.toLowerCase() !== phase3Evidence.creation.market.toLowerCase()) throw new Error('Market missing');
  return `The agent-created market is live through The Graph at indexed block ${reply.data._meta.block.number}.`;
});

if (phase3Evidence?.creation.market && env.HORIZON_REGISTRY_ADDRESS && env.EVM_RPC_URL) await check('Agent-created market on chain', async () => {
  const market = phase3Evidence!.creation.market;
  const call = (to: string, method: string, argument = '') =>
    rpc('eth_call', [{ to, data: `${keccak256(toHex(method)).slice(0, 10)}${argument}` }, 'latest']);
  const padded = market.slice(2).toLowerCase().padStart(64, '0');
  if (BigInt(await call(env.HORIZON_REGISTRY_ADDRESS!, 'isMarket(address)', padded)) !== 1n) throw new Error('Not a registered market');
  // The creation id is derived from the durable request id, which is what makes creation idempotent.
  const creationId = keccak256(toHex(`horizon-creation:${phase3Evidence!.requestId}`)).slice(2);
  const recorded = await call(env.HORIZON_REGISTRY_ADDRESS!, 'marketByCreationId(bytes32)', creationId);
  if (`0x${recorded.slice(-40)}`.toLowerCase() !== market.toLowerCase()) throw new Error('Creation id does not resolve to this market');
  const resolver = await call(market, 'resolver()');
  if (`0x${resolver.slice(-40)}`.toLowerCase() !== env.EVM_DEPLOYER_ADDRESS?.toLowerCase()) throw new Error('Unexpected resolver');
  return 'The paid agent request produced a registered market whose creation id derives from its request id, resolved by the disclosed Horizon resolver.';
});

// --- Public audit trail (Hedera Consensus Service) --------------------------
// Read-only against the mirror node. It never submits a statement and never prints a key.
const mirrorNode = env.HEDERA_MIRROR_NODE_URL || 'https://testnet.mirrornode.hedera.com';
const auditTopic = env.HEDERA_AUDIT_TOPIC_ID;
if (auditTopic && env.HEDERA_AUDIT_ACCOUNT_ID) {
  await check('Audit topic restricted to the audit signer', async () => {
    const topic = z.object({ topic_id: z.string(), memo: z.string().optional(), deleted: z.boolean().nullable().optional(),
      submit_key: z.object({ _type: z.string(), key: z.string() }).nullable().optional() })
      .parse(await json(`${mirrorNode.replace(/\/$/, '')}/api/v1/topics/${auditTopic}`));
    if (topic.deleted) throw new Error('Topic deleted');
    if (!topic.submit_key?.key) throw new Error('Topic accepts messages from any account');
    const { PrivateKey } = await import('@hiero-ledger/sdk');
    const raw = env.HEDERA_AUDIT_PRIVATE_KEY;
    if (raw) {
      // Only the derived public key is compared; the private key is never printed or stored.
      const value = raw.trim().replace(/^0x/, '');
      const key = env.HEDERA_AUDIT_KEY_TYPE === 'der' || (value.length > 64 && value.startsWith('30'))
        ? PrivateKey.fromStringDer(value)
        : env.HEDERA_AUDIT_KEY_TYPE === 'ed25519' ? PrivateKey.fromStringED25519(value) : PrivateKey.fromStringECDSA(value);
      if (!topic.submit_key.key.toLowerCase().includes(key.publicKey.toStringRaw().toLowerCase())) throw new Error('Submit key is not the configured audit signer');
    }
    return `Topic ${auditTopic} on Hedera ${env.HEDERA_AUDIT_NETWORK || 'testnet'} exists and accepts messages only from the configured audit signer${raw ? ', whose public key matches its submit key' : ''}.`;
  });
} else report('Audit topic', 'pending', 'Run npm run audit:topic and set HEDERA_AUDIT_TOPIC_ID, HEDERA_AUDIT_ACCOUNT_ID and HEDERA_AUDIT_PRIVATE_KEY.');

if (auditEvidence && auditEvidence.topicId) await check('Published audit statements', async () => {
  let matched = 0;
  for (const event of auditEvidence!.events) {
    if (event.status !== 'PUBLISHED' || !event.sequenceNumber) throw new Error('Recorded statement was never published');
    const message = z.object({ consensus_timestamp: z.string(), message: z.string(), sequence_number: z.number() })
      .parse(await json(`${mirrorNode.replace(/\/$/, '')}/api/v1/topics/${auditEvidence!.topicId}/messages/${event.sequenceNumber}`));
    const contents = Buffer.from(message.message, 'base64').toString('utf8');
    // The recorded event id must be the one actually on the topic at that sequence number.
    if (!contents.includes(event.eventId) || !contents.includes(auditEvidence!.requestId)) throw new Error('Mirror message does not match the recorded statement');
    matched++;
  }
  return `${matched} statement${matched === 1 ? '' : 's'} for request ${auditEvidence!.requestId} read back from the Hedera mirror node at their recorded sequence numbers. `
    + 'HCS attests Horizon\'s statements and their ordering only, not the referenced payment, deployment or outcome.';
});
else report('Published audit statements', 'pending', 'Publish a creation request\'s trail and record it with npm run audit:verify -- --latest --record.');

const worldFields = ['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_RP_SIGNING_KEY', 'WORLD_ACTION'] as const;
const missingWorld = worldFields.filter(key => !env[key]);
if (env.WORLD_SELFIE_ACCESS === 'granted' && missingWorld.length === 0 && ['sandbox', 'staging', 'production'].includes(env.WORLD_ENVIRONMENT ?? '')) {
  report('World', 'pending', `Selfie Check ${env.WORLD_ENVIRONMENT} configuration and server-side RP signing are ready. Complete one real credential verification to prove the discount path.`);
} else {
  report('World', 'pending', `Selfie Check access is ${env.WORLD_SELFIE_ACCESS || 'unknown'}; ${missingWorld.length ? `missing ${missingWorld.join(', ')}.` : 'select sandbox, staging or production explicitly.'}`);
}
report('AI drafting provider', env.AI_PROVIDER === 'anthropic' && Boolean(env.ANTHROPIC_API_KEY) ? 'ok' : 'pending',
  env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY ? 'Anthropic drafting is configured; live Graph duplicate context is supplied by the creation service.' : 'The Graph-grounded deterministic fallback works, but a live AI provider is not configured.');
if (env.NODE_ENV === 'production' && /^https:\/\//.test(env.WEB_ORIGIN ?? '')) await check('Public HTTPS app and API', async () => {
  const origin = new URL(env.WEB_ORIGIN!).origin;
  const ready = z.object({ status: z.literal('ok'), database: z.literal('reachable') }).parse(await json(`${origin}/health/ready`));
  if (ready.status !== 'ok') throw new Error('Not ready');
  return `The public HTTPS service at ${origin} reports its database ready.`;
});
else report('Public HTTPS app and API', 'pending', 'Deploy the combined frontend/API and worker with PostgreSQL, then set NODE_ENV=production, the HTTPS WEB_ORIGIN and trusted proxy count.');
if (env.HORIZON_REGISTRY_ADDRESS && env.HORIZON_ROUTER_ADDRESS && env.HORIZON_EXECUTOR_ADDRESS && env.EVM_RPC_URL) {
  await check('Horizon deployment wiring', async () => {
    for (const key of ['HORIZON_REGISTRY_ADDRESS', 'HORIZON_ROUTER_ADDRESS', 'HORIZON_EXECUTOR_ADDRESS'] as const) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(env[key]!) || await rpc('eth_getCode', [env[key], 'latest']) === '0x') throw new Error('Invalid deployed contract');
    }
    for (const [contract, method, expected] of [
      [env.HORIZON_ROUTER_ADDRESS, 'registry()', env.HORIZON_REGISTRY_ADDRESS],
      [env.HORIZON_ROUTER_ADDRESS, 'AQUA()', env.AQUA_ADDRESS],
      [env.HORIZON_EXECUTOR_ADDRESS, 'router()', env.HORIZON_ROUTER_ADDRESS],
      [env.HORIZON_REGISTRY_ADDRESS, 'usdc()', env.USDC_ADDRESS],
    ]) {
      const result = await rpc('eth_call', [{ to: contract, data: keccak256(toHex(method!)).slice(0, 10) }, 'latest']);
      if (`0x${result.slice(-40)}`.toLowerCase() !== expected!.toLowerCase()) throw new Error('Wiring mismatch');
    }
    return 'Registry, curve router, route executor, Aqua and USDC wiring verified. Live transaction evidence is in deployments/phase2-evidence.json.';
  });
} else report('Custom Horizon router', 'pending', 'Set deployed Horizon registry/router/executor addresses after deployment.');
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
process.exitCode = checks.some(c => c.status === 'failed') ? 1 : checks.some(c => c.status === 'pending') ? 2 : 0;
