import { readFile, writeFile } from 'node:fs/promises';
import { createWalletClient, http, erc20Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { QuoteService, type TradingConfig } from '../src/trading/service.js';
import { marketAbi } from '../src/trading/abi.js';

const stringify = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
async function main() {
  const d = JSON.parse(await readFile('deployments/sepolia.json', 'utf8')) as TradingConfig;
  const demo = JSON.parse(await readFile('deployments/phase2-demo.json', 'utf8')) as { maker: Address; taker: Address; markets: Address[]; seeded: boolean };
  if (!demo.seeded || demo.markets.length !== 2) throw new Error('Demo seeding incomplete');
  const env = process.env, raw = env.EVM_DEPLOYER_PRIVATE_KEY!;
  const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);
  if (account.address !== demo.taker) throw new Error('Demo taker mismatch');
  const service = new QuoteService({ ...d, rpc: env.EVM_RPC_URL!, graph: env.GRAPH_QUERY_URL!, graphKey: env.GRAPH_API_KEY });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.EVM_RPC_URL!, { retryCount: 0 }) });
  const client = service.client;
  const input = { account: account.address, recipient: account.address, isYes: true, isBuy: true, slippageBps: 50 };
  const path = 'deployments/phase2-evidence.json';
  let evidence: any;
  try { evidence = JSON.parse(await readFile(path, 'utf8')); } catch {}
  if (evidence?.completed) { console.log('Live evidence already recorded; no repeated trade.'); return; }
  if (!evidence) {
    const [quoteA, quoteB] = await Promise.all([
      service.quote({ ...input, market: demo.markets[0]!, shares: 2_000_000n }),
      service.quote({ ...input, market: demo.markets[1]!, shares: 1_000_000n }),
    ]);
    if (quoteA.simulation !== 'passed' || quoteB.simulation !== 'passed' || quoteA.legs.length !== 2) throw new Error('Live Graph quotes not ready or insufficient funding');
    const makerBefore = await client.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [demo.maker] });
    evidence = { startedAt: new Date().toISOString(), quoteA, quoteBBefore: quoteB, makerBefore, completed: false };
    await writeFile(path, stringify(evidence));
  }
  if (!evidence.transaction) {
    if (evidence.broadcastAttempted) throw new Error('Ambiguous previous broadcast: reconcile nonce before retry');
    // Revalidate the EXACT saved calldata against latest chain state, including deadline and expected filled counters.
    await client.call({ account, to: d.executor, data: evidence.quoteA.transaction.data });
    evidence.broadcastAttempted = true;
    evidence.nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    await writeFile(path, stringify(evidence));
    const hash = await wallet.sendTransaction({ to: d.executor, data: evidence.quoteA.transaction.data, nonce: evidence.nonce });
    evidence.transaction = hash; await writeFile(path, stringify(evidence));
    console.log(`Atomic two-curve trade broadcast: ${hash}`);
  }
  const receipt = await client.waitForTransactionReceipt({ hash: evidence.transaction, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error('Live route reverted');
  const yes = await client.readContract({ address: demo.markets[0]!, abi: marketAbi, functionName: 'yesToken' });
  const [holdings, collateral, makerAfter] = await Promise.all([
    client.readContract({ address: yes, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
    client.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [demo.markets[0]!] }),
    client.readContract({ address: d.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [demo.maker] }),
  ]);
  if (holdings !== 2_000_000n || collateral !== 2_000_000n || makerAfter >= BigInt(evidence.makerBefore)) throw new Error('Unexpected live balances');
  let secondMarketRejected = false;
  try { await service.quote({ ...input, market: demo.markets[1]!, shares: 1_000_000n }); }
  catch (e) { if (e instanceof Error && e.message === 'insufficient_executable_liquidity') secondMarketRejected = true; else throw e; }
  if (!secondMarketRejected) throw new Error('Shared wallet reduction not reflected in next quote');
  let staleRejected = false;
  try { await client.call({ account, to: d.executor, data: evidence.quoteA.transaction.data }); } catch { staleRejected = true; }
  if (!staleRejected) throw new Error('Stale route was accepted');
  Object.assign(evidence, { transactionBlock: receipt.blockNumber, holdings, collateral, makerAfter, secondMarketRejected, staleRejected, completed: true, completedAt: new Date().toISOString() });
  await writeFile(path, stringify(evidence));
  console.log(`Verified live two-fill route ${receipt.transactionHash}; 2 YES backed by 2 USDC. Shared-wallet and stale-route rejection confirmed.`);
}
main().catch(error => { console.error(`Live verification stopped: ${error instanceof Error && /^[A-Za-z _:-]+$/.test(error.message) ? error.message : 'check live indexing, funding, and recorded transaction state'}. No secrets logged.`); process.exitCode = 1; });
