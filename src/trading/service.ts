import { createPublicClient, http, erc20Abi, encodeAbiParameters, parseAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { allocate, type Candidate, RoutingError } from './allocator.js';
import { isBuy, isYes } from './math.js';
import { GraphProvider } from './graph.js';
import { routerAbi, routeAbi, marketAbi, orderBudgetAbi, registryAbi, aquaAbi } from './abi.js';

export type TradingConfig = { rpc: string; graph: string; graphKey?: string; router: Address; executor: Address; registry: Address; aqua: Address; usdc: Address };
export type QuoteInput = { market: Address; account: Address; recipient: Address; isYes: boolean; isBuy: boolean; shares: bigint; slippageBps: number };
export class QuoteService {
  readonly graph: GraphProvider;
  readonly client;
  constructor(readonly config: TradingConfig) {
    this.graph = new GraphProvider(config.graph, config.graphKey);
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) });
  }
  async quote(input: QuoteInput) {
    const c = this.config;
    if (await this.client.getChainId() !== 11155111) throw new RoutingError('wrong_chain');
    const discovered = await this.graph.candidates(input.market);
    const block = await this.client.getBlock();
    if (BigInt(discovered.block) > block.number || block.number - BigInt(discovered.block) > 64n) throw new RoutingError('stale_graph');
    const indexed = await this.client.getBlock({ blockNumber: BigInt(discovered.block) });
    if (indexed.hash.toLowerCase() !== discovered.hash.toLowerCase()) throw new RoutingError('graph_reorg');
    const read = <T>(params: T) => this.client.readContract({ ...params, blockNumber: block.number } as any) as Promise<any>;
    if (!await read({ address: c.registry, abi: registryAbi, functionName: 'isMarket', args: [input.market] })) throw new RoutingError('unknown_market');
    if (!await read({ address: input.market, abi: marketAbi, functionName: 'isOpen' })) throw new RoutingError('market_closed');
    const token = await read({ address: input.market, abi: marketAbi, functionName: input.isYes ? 'yesToken' : 'noToken' }) as Address;
    const ledger = await read({ address: c.router, abi: routerAbi, functionName: 'budget' }) as Address;
    const eligible = discovered.candidates.filter(s => input.isBuy
      ? (isBuy(s.strategy) ? isYes(s.strategy) !== input.isYes : isYes(s.strategy) === input.isYes)
      : isBuy(s.strategy) && isYes(s.strategy) === input.isYes);
    const candidates: Candidate[] = [];
    // Sequential candidate refresh bounds RPC concurrency and captures every value at the same block.
    for (const item of eligible) {
      try {
        const order = await read({ address: c.router, abi: routerAbi, functionName: 'buildCurveOrder', args: [item.maker, item.strategy] });
        const hash = keccak256(encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'), [order]));
        if (hash !== item.id) continue;
        // Anyone can ship a strategy to Aqua naming this router. Only an order the router has
        // admitted — the step that checks its market budget — can actually fill, so an indexed
        // order that skipped it is not liquidity and never reaches the allocator.
        if (!await read({ address: ledger, abi: orderBudgetAbi, functionName: 'isAdmitted', args: [hash] })) continue;
        const outcome = await read({ address: c.router, abi: routerAbi, functionName: 'curveOutcome', args: [item.strategy] }) as Address;
        const outputToken = isBuy(item.strategy) ? c.usdc : outcome;
        const inputToken = isBuy(item.strategy) ? outcome : c.usdc;
        const [filled, balances, walletBalance, allowance] = await Promise.all([
          read({ address: c.router, abi: routerAbi, functionName: 'filledShares', args: [hash] }),
          read({ address: c.aqua, abi: aquaAbi, functionName: 'safeBalances', args: [item.maker, c.router, hash, inputToken, outputToken] }),
          read({ address: outputToken, abi: erc20Abi, functionName: 'balanceOf', args: [item.maker] }),
          read({ address: outputToken, abi: erc20Abi, functionName: 'allowance', args: [item.maker, c.aqua] }),
        ]) as [bigint, readonly [bigint, bigint], bigint, bigint];
        candidates.push({ ...item, filled, allocation: balances[1], walletAvailable: walletBalance < allowance ? walletBalance : allowance, outputToken });
      } catch { /* A revoked or invalid candidate is not executable. Never substitute indexed balances. */ }
    }
    const allocation = allocate(candidates, input.shares, input.isBuy);
    const limit = input.isBuy ? (allocation.usdc * BigInt(10_000 + input.slippageBps) + 9999n) / 10000n
      : allocation.usdc * BigInt(10_000 - input.slippageBps) / 10000n;
    const request = { market: input.market, isYes: input.isYes, isBuy: input.isBuy, shares: input.shares, limit,
      recipient: input.recipient, deadline: Number(block.timestamp + 120n) };
    const legs = allocation.fills.map(f => ({ maker: f.candidate.maker, strategy: f.candidate.strategy, shares: f.shares, expectedFilled: f.candidate.filled }));
    const data = encodeFunctionData({ abi: routeAbi, functionName: 'execute', args: [request, legs] });
    const fundingToken = input.isBuy ? c.usdc : token, fundingAmount = input.isBuy ? limit : input.shares;
    const [balance, allowance] = await Promise.all([
      read({ address: fundingToken, abi: erc20Abi, functionName: 'balanceOf', args: [input.account] }),
      read({ address: fundingToken, abi: erc20Abi, functionName: 'allowance', args: [input.account, c.executor] }),
    ]) as [bigint, bigint];
    let simulation: 'passed' | 'approval_required' | 'insufficient_balance';
    if (balance < fundingAmount) simulation = 'insufficient_balance';
    else if (allowance < fundingAmount) simulation = 'approval_required';
    else {
      try { await this.client.simulateContract({ address: c.executor, abi: routeAbi, functionName: 'execute', args: [request, legs], account: input.account, blockNumber: block.number }); simulation = 'passed'; }
      catch { throw new RoutingError('route_simulation_failed_requote'); }
    }
    const canonical = await this.client.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash) throw new RoutingError('snapshot_reorg');
    return { chainId: 11155111, market: input.market, shares: input.shares, usdc: allocation.usdc, limit, deadline: request.deadline,
      fees: { maker: 0, taker: 0, routing: 0, protocol: 0 }, simulation,
      snapshot: { block: block.number, hash: block.hash, indexedBlock: discovered.block, indexedHash: discovered.hash },
      search: { candidateLimit: 32, fillLimit: 4, method: 'bounded_chunk_search' },
      approval: { token: fundingToken, spender: c.executor, amount: fundingAmount },
      transaction: { to: c.executor, data, value: '0' }, legs };
  }
}
