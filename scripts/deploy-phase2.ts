import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, keccak256, getContractAddress, parseEther, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { routerAbi, routeAbi, orderBudgetAbi, registryAbi } from '../src/trading/abi.js';

type Deployment = { chainId: number; owner: Address; aqua: Address; usdc: Address; startBlock?: string; registry?: Address; router?: Address; executor?: Address; orderBudget?: Address; transactions: Record<string, Hex>; pending?: { name: string; address: Address; nonce: number; hash?: Hex } };
const path = 'deployments/sepolia.json';
async function main() {
  if (!process.argv.includes('--broadcast')) throw new Error('Pass --broadcast to deploy to Sepolia');
  const env = process.env;
  if (!env.EVM_RPC_URL || !env.EVM_DEPLOYER_PRIVATE_KEY || !env.AQUA_ADDRESS || !env.USDC_ADDRESS) throw new Error('Missing deployment configuration');
  const raw = env.EVM_DEPLOYER_PRIVATE_KEY;
  const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
  if (account.address.toLowerCase() !== env.EVM_DEPLOYER_ADDRESS?.toLowerCase()) throw new Error('Deployer address mismatch');
  const client = createPublicClient({ chain: sepolia, transport: http(env.EVM_RPC_URL, { retryCount: 1 }) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.EVM_RPC_URL, { retryCount: 0 }) });
  if (await client.getChainId() !== 11155111) throw new Error('Not Sepolia');
  const proof = JSON.parse(await readFile('deployments/aqua-verification.json', 'utf8')) as { address: Address; runtimeHash: Hex };
  if (env.AQUA_ADDRESS.toLowerCase() !== proof.address.toLowerCase()) throw new Error('Unverified Aqua address');
  const code = await client.getCode({ address: proof.address });
  if (!code || keccak256(code) !== proof.runtimeHash) throw new Error('Aqua runtime differs from verified source');
  let state: Deployment = { chainId: 11155111, owner: account.address, aqua: proof.address, usdc: env.USDC_ADDRESS as Address, transactions: {} };
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch {}
  if (state.owner !== account.address || state.aqua.toLowerCase() !== proof.address.toLowerCase() || state.usdc.toLowerCase() !== env.USDC_ADDRESS.toLowerCase()) throw new Error('Existing deployment configuration differs');
  await mkdir('deployments', { recursive: true });
  const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n');
  let spentCeiling = 0n;
  async function deploy(name: string, key: 'registry' | 'router' | 'executor', args: unknown[]) {
    if (state[key]) {
      if (!await client.getCode({ address: state[key] })) throw new Error('Recorded deployment has no code');
      return state[key]!;
    }
    if (state.pending && state.pending.name !== name) throw new Error('Another deployment is pending');
    if (state.pending && !state.pending.hash) throw new Error('Ambiguous previous broadcast; reconcile recorded nonce before retry');
    if (!state.pending) {
      const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
      if ((artifact.deployedBytecode.object.length - 2) / 2 > 24576) throw new Error('Contract exceeds runtime size limit');
      const fees = await client.estimateFeesPerGas();
      if (!fees.maxFeePerGas || fees.maxFeePerGas > 20_000_000_000n) throw new Error('Testnet gas ceiling exceeded');
      // Deploy gas must include constructor arguments; viem uses the same encoding for estimation and sending.
      const { encodeDeployData } = await import('viem');
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
      const estimated = await client.estimateGas({ account, data });
      const gasLimit = estimated * 12n / 10n;
      spentCeiling += gasLimit * fees.maxFeePerGas;
      if (spentCeiling > parseEther('0.1')) throw new Error('Deployment cost exceeds 0.1 test ETH ceiling');
      if (await client.getBalance({ address: account.address }) < gasLimit * fees.maxFeePerGas) throw new Error('Insufficient test ETH');
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
      state.pending = { name, nonce, address: getContractAddress({ from: account.address, nonce: BigInt(nonce) }) };
      await save();
      const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args, nonce, gas: gasLimit, ...fees });
      state.pending.hash = hash; await save();
      console.log(`${name}: broadcast ${hash}`);
    }
    const receipt = await client.waitForTransactionReceipt({ hash: state.pending!.hash!, confirmations: 1, timeout: 120_000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment reverted');
    state[key] = receipt.contractAddress;
    state.transactions[name] = receipt.transactionHash;
    state.startBlock ??= receipt.blockNumber.toString();
    delete state.pending; await save();
    console.log(`${name}: ${receipt.contractAddress}`);
    return receipt.contractAddress;
  }
  const registry = await deploy('MarketRegistry', 'registry', [state.usdc, account.address]);
  const router = await deploy('HorizonSwapVM', 'router', [state.aqua, registry, account.address]);
  const executor = await deploy('RouteExecutor', 'executor', [router]);
  const [actualUSDC, actualRegistry, actualAqua, actualRouter, orderBudget] = await Promise.all([
    client.readContract({ address: registry, abi: registryAbi, functionName: 'usdc' }),
    client.readContract({ address: router, abi: routerAbi, functionName: 'registry' }),
    client.readContract({ address: router, abi: routerAbi, functionName: 'AQUA' }),
    client.readContract({ address: executor, abi: routeAbi, functionName: 'router' }),
    // The router deploys its own order-budget ledger, so this is a record, never a configuration.
    client.readContract({ address: router, abi: routerAbi, functionName: 'budget' }),
  ]);
  if ([actualUSDC, actualRegistry, actualAqua, actualRouter].map(x => x.toLowerCase()).join() !== [state.usdc, registry, state.aqua, router].map(x => x.toLowerCase()).join()) throw new Error('Deployed wiring mismatch');
  const ledgerApp = await client.readContract({ address: orderBudget, abi: orderBudgetAbi, functionName: 'app' });
  if (ledgerApp.toLowerCase() !== router.toLowerCase()) throw new Error('Order budget is not owned by this router');
  state.orderBudget = orderBudget; await save();
  console.log(`OrderBudget: ${orderBudget}`);
  let localEnv = await readFile('.env', 'utf8');
  for (const [key, value] of Object.entries({ HORIZON_REGISTRY_ADDRESS: registry, HORIZON_ROUTER_ADDRESS: router, HORIZON_EXECUTOR_ADDRESS: executor })) {
    const line = new RegExp(`^${key}=.*$`, 'm'); localEnv = line.test(localEnv) ? localEnv.replace(line, `${key}=${value}`) : `${localEnv.trimEnd()}\n${key}=${value}\n`;
  }
  await writeFile('.env', localEnv, { mode: 0o600 });
  console.log('Sepolia deployment and wiring verified; public manifest and local environment updated.');
}
main().catch(() => { console.error('Deployment stopped. No secrets logged. Inspect deployments/sepolia.json for pending transaction status before retrying.'); process.exitCode = 1; });
