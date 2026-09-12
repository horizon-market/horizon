import { createPublicClient, createWalletClient, http, erc20Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

/**
 * Rests curves on one open market from the deployer wallet, prepared by the same endpoint the
 * trade ticket uses (`POST /api/curves`), so the two on-chain steps — `ship` to Aqua and
 * `admitCurve` on the router — are exactly what a browser maker signs.
 *
 *   npm run demo:curves -- --market 0x… [--api https://…] [--curve side:start:end:shares:shape …]
 *
 * `side` is buy-yes, buy-no, sell-yes or sell-no; prices are USDC per share; shape is 1, 2 or 3.
 * The defaults seed a tight two-sided book for a recording: a NO bid, which the market shows as
 * the YES ask, and a YES bid just under it. Fees on any of this: none, only gas.
 */
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const args = (name: string) => process.argv.flatMap((v, i) => v === name && process.argv[i + 1] ? [process.argv[i + 1]!] : []);
const api = (arg('--api') ?? 'https://horizon-production-8c50.up.railway.app').replace(/\/$/, '');
const market = arg('--market') as Address | undefined;
const specs = args('--curve').length ? args('--curve') : ['buy-no:0.55:0.45:10:1', 'buy-yes:0.42:0.35:10:2'];
if (!market || !/^0x[0-9a-fA-F]{40}$/.test(market)) throw new Error('Pass --market 0x… (the market address)');

type Prepared = {
  orderHash: Hex; readiness: 'ready' | 'approval_required' | 'insufficient_balance' | 'over_budget';
  budget: { requested: string; required: string; shortfall: string };
  approval: { token: Address; spender: Address; amount: string };
  transaction: { to: Address; data: Hex; value: string }; admission: { to: Address; data: Hex; value: string };
};
const micro = (usdc: string) => Math.round(Number(usdc) * 1_000_000);

async function main() {
  const raw = process.env.EVM_DEPLOYER_PRIVATE_KEY;
  if (!raw || !process.env.EVM_RPC_URL) throw new Error('EVM_DEPLOYER_PRIVATE_KEY and EVM_RPC_URL are required');
  const maker = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.EVM_RPC_URL) });
  const wallet = createWalletClient({ account: maker, chain: sepolia, transport: http(process.env.EVM_RPC_URL, { retryCount: 0 }) });
  if (await client.getChainId() !== 11155111) throw new Error('Not Sepolia');
  const send = async (label: string, tx: { to: Address; data: Hex }) => {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    console.log(`${label}: ${hash}`);
  };
  console.log(`maker ${maker.address} · market ${market} · ${api}`);
  for (const spec of specs) {
    const [side = '', start = '', end = '', shares = '', shape = '1'] = spec.split(':');
    const [direction, outcome] = side.split('-');
    if (!['buy', 'sell'].includes(direction ?? '') || !['yes', 'no'].includes(outcome ?? '')) throw new Error(`Bad curve spec: ${spec}`);
    const body = { maker: maker.address, market, isYes: outcome === 'yes', isBuy: direction === 'buy',
      startPrice: micro(start), endPrice: micro(end), shares: String(micro(shares)), shape: Number(shape) };
    const response = await fetch(`${api}/api/curves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`prepare ${spec}: ${response.status} ${await response.text()}`);
    const prepared = await response.json() as Prepared;
    console.log(`\n${spec} → order ${prepared.orderHash} · needs ${Number(prepared.budget.requested) / 1e6} · ${prepared.readiness}`);
    if (prepared.readiness === 'insufficient_balance' || prepared.readiness === 'over_budget') {
      throw new Error(`Wallet cannot fund this order (short ${Number(prepared.budget.shortfall) / 1e6}); fund it or reduce the size.`);
    }
    if (prepared.readiness === 'approval_required') {
      const hash = await wallet.writeContract({ address: prepared.approval.token, abi: erc20Abi, functionName: 'approve',
        args: [prepared.approval.spender, BigInt(prepared.approval.amount)] });
      await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      console.log(`approve ${Number(prepared.approval.amount) / 1e6} for Aqua: ${hash}`);
    }
    await send('ship (Aqua allocation)', prepared.transaction);
    await send('admitCurve (Horizon router)', prepared.admission);
  }
  console.log(`\nDone. ${api}/markets/${market}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
