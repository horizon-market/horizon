import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, toHex, encodeAbiParameters, parseAbiParameters, parseEther, type Address, type Hex, type Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { registryAbi, routerAbi, marketAbi, aquaAbi } from '../src/trading/abi.js';
import { cumulative, type Curve } from '../src/trading/math.js';

async function main() {
  const d = JSON.parse(await readFile('deployments/sepolia.json', 'utf8')) as { registry: Address; router: Address; executor: Address; aqua: Address; usdc: Address };
  const env = process.env, raw = env.EVM_DEPLOYER_PRIVATE_KEY!;
  const owner = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
  const client = createPublicClient({ chain: sepolia, transport: http(env.EVM_RPC_URL!) });
  if (await client.getChainId() !== 11155111) throw new Error('Not Sepolia');
  await mkdir('.local', { recursive: true });
  let makerKey: Hex;
  try { makerKey = (await readFile('.local/phase2-maker-key', 'utf8')).trim() as Hex; }
  catch { makerKey = generatePrivateKey(); await writeFile('.local/phase2-maker-key', makerKey, { mode: 0o600 }); }
  const maker = privateKeyToAccount(makerKey);
  const wallet = createWalletClient({ account: owner, chain: sepolia, transport: http(env.EVM_RPC_URL!, { retryCount: 0 }) });
  const makerWallet = createWalletClient({ account: maker, chain: sepolia, transport: http(env.EVM_RPC_URL!, { retryCount: 0 }) });
  type State = { maker: Address; taker: Address; markets: Address[]; strategies: { market: Address; id: Hex; strategy: Omit<Curve, 'maxShares'> & { maxShares: string } }[]; transactions: Record<string, Hex>; seeded: boolean };
  let state: State = { maker: maker.address, taker: owner.address, markets: [], strategies: [], transactions: {}, seeded: false };
  try { state = JSON.parse(await readFile('deployments/phase2-demo.json', 'utf8')); } catch {}
  if (state.seeded) { console.log('Demo seed already complete; no additional funds sent.'); return; }
  if (state.maker !== maker.address || state.taker !== owner.address) throw new Error('Demo wallet mismatch');
  const save = () => writeFile('deployments/phase2-demo.json', JSON.stringify(state, null, 2) + '\n');
  const confirm = async (name: string, send: () => Promise<Hex>) => {
    const hash = state.transactions[name] ?? await send(); state.transactions[name] = hash; await save();
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error('Seed transaction reverted'); console.log(`${name}: ${hash}`);
  };
  // Fixed testnet funding caps: 0.01 ETH and 1 USDC to a distinct demonstration maker.
  await confirm('makerGas', () => wallet.sendTransaction({ to: maker.address, value: parseEther('0.01') }));
  await confirm('makerUSDC', () => wallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'transfer', args: [maker.address, 1_000_000n] }));
  await confirm('makerApproval', () => makerWallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'approve', args: [d.aqua, 1_000_000n] }));
  await confirm('takerApproval', () => wallet.writeContract({ address: d.usdc, abi: erc20Abi, functionName: 'approve', args: [d.executor, 3_000_000n] }));
  for (let i = 0; i < 2; i++) {
    const id = keccak256(toHex(`horizon-phase2-demo-${d.registry}-${i}`));
    let market = await client.readContract({ address: d.registry, abi: registryAbi, functionName: 'marketByCreationId', args: [id] });
    if (market === '0x0000000000000000000000000000000000000000') {
      const b = await client.getBlock();
      const question = i === 0 ? 'Will the Horizon Phase 2 demo execute a two-curve YES purchase before this market closes?' : 'Will the Horizon Phase 2 demo show reduced shared maker USDC across two markets before this market closes?';
      await confirm(`market${i}`, () => wallet.writeContract({ address: d.registry, abi: registryAbi, functionName: 'createMarket', args: [id, question,
        'Demonstration market using test USDC. YES if the public Phase 2 transaction evidence proves the stated condition before closeAt; NO otherwise; INVALID if evidence cannot be verified. Resolver is the disclosed Horizon demo admin.',
        'Horizon deployments/phase2-demo.json, deployments/phase2-evidence.json and Sepolia transaction receipts', Number(b.timestamp + 3n * 86400n), owner.address] }));
      market = await client.readContract({ address: d.registry, abi: registryAbi, functionName: 'marketByCreationId', args: [id] });
    }
    state.markets[i] = market; await save();
    const no = await client.readContract({ address: market, abi: marketAbi, functionName: 'noToken' });
    for (let j = 0; j < (i === 0 ? 2 : 1); j++) {
      const strategy: Curve = { market, flags: j === 0 ? 6 : 10, startPrice: i === 0 ? 450000 : 400000,
        endPrice: i === 0 ? 350000 : 400000, maxShares: 1_000_000n, salt: keccak256(toHex(`phase2-${i}-${j}`)) };
      const order = await client.readContract({ address: d.router, abi: routerAbi, functionName: 'buildCurveOrder', args: [maker.address, strategy] });
      const encoded = encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'), [order]);
      await confirm(`curve${i}-${j}`, () => makerWallet.writeContract({ address: d.aqua, abi: aquaAbi, functionName: 'ship', args: [d.router, encoded, [no, d.usdc], [0n, cumulative(strategy, strategy.maxShares)]] }));
      if (!state.strategies.some(s => s.id === keccak256(encoded))) state.strategies.push({ market, id: keccak256(encoded), strategy: { ...strategy, maxShares: strategy.maxShares.toString() } });
      await save();
    }
  }
  state.seeded = true; await save(); console.log('Published three curves in two live markets using one shared maker wallet.');
}
main().catch(() => { console.error('Demo seeding stopped; inspect public transaction records before retrying. No secrets logged.'); process.exitCode = 1; });
