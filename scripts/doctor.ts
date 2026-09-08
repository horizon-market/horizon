import { z } from 'zod';
import { keccak256, toHex, type Hex } from 'viem';
import { readFile } from 'node:fs/promises';

type Check = { name: string; status: 'ok' | 'pending' | 'failed'; detail: string };
const checks: Check[] = [];
const env = process.env;
const report = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });

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
report('Hedera paid requests', 'pending', 'Agent account/key, receiver and browser WalletConnect project are prerequisites. Both real paid flows remain unimplemented.');

if (env.GRAPH_QUERY_URL) await check('Graph query endpoint', async () => {
  const reply = z.object({ data: z.object({ _meta: z.object({ block: z.object({ number: z.number() }), hasIndexingErrors: z.boolean() }) }) }).parse(await json(env.GRAPH_QUERY_URL!, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(env.GRAPH_API_KEY ? { authorization: `Bearer ${env.GRAPH_API_KEY}` } : {}) },
    body: JSON.stringify({ query: '{ _meta { block { number } hasIndexingErrors } markets(first: 1) { id } strategies(first: 1) { id } routes(first: 1) { id } }' }),
  }));
  if (reply.data._meta.hasIndexingErrors) throw new Error('Indexing errors');
  return `Live Horizon market/strategy/route query succeeded at indexed block ${reply.data._meta.block.number}.`;
});
else report('Graph', 'pending', 'Studio/deploy access and live Horizon query endpoint needed after contracts emit events.');

report('World', 'pending', `Selfie Check access declared ${['unknown', 'requested', 'granted'].includes(env.WORLD_SELFIE_ACCESS ?? '') ? env.WORLD_SELFIE_ACCESS : 'unknown'}. App configuration and an actual credential verification are still required.`);
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
