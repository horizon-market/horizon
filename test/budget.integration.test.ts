import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, erc20Abi, encodeAbiParameters, parseAbiParameters,
  keccak256, type Abi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { routerAbi, routeAbi, registryAbi, marketAbi, aquaAbi, orderBudgetAbi } from '../src/trading/abi.js';
import { cumulative, type Curve } from '../src/trading/math.js';
import { MarketService, MarketError } from '../src/trading/markets.js';
import { QuoteService } from '../src/trading/service.js';

/**
 * The per-market order budget against a real EVM, at the boundary that enforces it: the router's
 * admission step. The API's own accounting is checked against the contract's in the same run, and
 * the bypass this exists to close — shipping straight to Aqua — is exercised rather than asserted.
 */
test('real EVM: per-market order budgets, their enforcement, and the direct-Aqua bypass', { timeout: 120_000 }, async () => {
  const reservation = createSocketServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '11155111', '--silent'], { stdio: 'ignore' });
  let startupError: Error | undefined;
  anvil.on('error', error => { startupError = error; });
  const rpc = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) });
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpc) });
  const graph = createServer();
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (startupError) throw new Error('Anvil could not start; install Foundry and add its bin directory to PATH');
      if (anvil.exitCode !== null) throw new Error('Anvil exited during startup');
      try { await client.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready);
    const [owner, maker, taker] = await wallet.getAddresses();
    assert.ok(owner && maker && taker);

    const artifact = async (name: string, file = name) =>
      JSON.parse(await readFile(`contracts/out/${file}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
    const deploy = async (name: string, args: unknown[] = [], file = name) => {
      const compiled = await artifact(name, file);
      const tx = await wallet.deployContract({ account: owner, abi: compiled.abi, bytecode: compiled.bytecode.object, args });
      const receipt = await client.waitForTransactionReceipt({ hash: tx });
      assert.equal(receipt.status, 'success');
      return receipt.contractAddress!;
    };
    const write = async (account: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
      const tx = await wallet.writeContract({ account, address, abi, functionName, args });
      const receipt = await client.waitForTransactionReceipt({ hash: tx });
      assert.equal(receipt.status, 'success');
      return receipt;
    };

    const token = await artifact('TestUSDC', 'TestBase');
    const usdc = (await client.waitForTransactionReceipt({
      hash: await wallet.deployContract({ account: owner, abi: token.abi, bytecode: token.bytecode.object }) })).contractAddress!;
    const aqua = await deploy('Aqua');
    const registry = await deploy('MarketRegistry', [usdc, owner]);
    const router = await deploy('HorizonSwapVM', [aqua, registry, owner]);
    const executor = await deploy('RouteExecutor', [router]);
    const block = await client.getBlock();
    const markets: Address[] = [];
    for (const [index, question] of [[1, 'Budget market A'], [2, 'Budget market B']] as const) {
      const id = keccak256(`0x0${index}` as Hex);
      await write(owner, registry, registryAbi, 'createMarket',
        [id, question, 'Rules', 'https://example.test', Number(block.timestamp + 86_400n), owner]);
      markets.push(await client.readContract({ address: registry, abi: registryAbi, functionName: 'marketByCreationId', args: [id] }) as Address);
    }
    const [marketA, marketB] = markets as [Address, Address];
    const yesToken = await client.readContract({ address: marketA, abi: marketAbi, functionName: 'yesToken' }) as Address;
    // The router deploys its own ledger, so the address can only ever be the right one.
    const ledger = await client.readContract({ address: router, abi: routerAbi, functionName: 'budget' }) as Address;
    assert.equal((await client.readContract({ address: ledger, abi: orderBudgetAbi, functionName: 'app' }) as string).toLowerCase(),
      router.toLowerCase());

    const config = { rpc, graph: 'http://127.0.0.1:1/unused', router, executor, registry, aqua, usdc };
    const service = new MarketService(config);
    const curve = (market: Address, flags: number, start: number, end: number, size: bigint, salt: number): Curve =>
      ({ market, flags, startPrice: start, endPrice: end, maxShares: size, salt: keccak256(`0x0${salt}` as Hex) });
    const encode = async (strategy: Curve) => {
      const order = await client.readContract({ address: router, abi: routerAbi, functionName: 'buildCurveOrder', args: [maker, strategy] });
      return encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'), [order]);
    };
    /** Publication step one only: the order exists in Aqua and cannot fill. */
    const ship = async (strategy: Curve) => {
      const encoded = await encode(strategy);
      const outcome = await client.readContract({ address: router, abi: routerAbi, functionName: 'curveOutcome', args: [strategy] }) as Address;
      const buying = (strategy.flags & 2) !== 0;
      const amounts = buying ? [0n, cumulative(strategy, strategy.maxShares)] : [strategy.maxShares, 0n];
      await write(maker, aqua, aquaAbi, 'ship', [router, encoded, [outcome, usdc], amounts]);
      return keccak256(encoded);
    };
    const admit = (strategy: Curve) => write(maker, router, routerAbi, 'admitCurve', [strategy]);
    const publish = async (strategy: Curve) => { const hash = await ship(strategy); await admit(strategy); return hash; };
    const refuses = async (strategy: Curve) => {
      await ship(strategy);
      await assert.rejects(client.simulateContract({ address: router, abi: routerAbi, functionName: 'admitCurve', args: [strategy], account: maker }),
        /MarketBudgetExceeded|reverted/i);
    };
    const onChainBudget = (market: Address, asset: Address) => client.readContract({
      address: ledger, abi: orderBudgetAbi, functionName: 'marketBudget', args: [maker, market, asset] }) as Promise<readonly [bigint, bigint, bigint, bigint]>;

    await write(owner, usdc, token.abi, 'mint', [maker, 100_000_000n]);
    await write(owner, usdc, token.abi, 'mint', [taker, 100_000_000n]);
    await write(taker, usdc, erc20Abi, 'approve', [executor, 100_000_000n]);
    // Exactly seven USDC of spendable funds, so the arithmetic below has no slack anywhere.
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 7_000_000n]);

    // ---- a limit order and a curve share one market budget ------------------------------------
    const limit = curve(marketA, 7, 400_000, 400_000, 10_000_000n, 1);
    const shaped = curve(marketA, 6, 400_000, 200_000, 10_000_000n, 2);
    assert.equal(cumulative(limit, limit.maxShares), 4_000_000n);
    assert.equal(cumulative(shaped, shaped.maxShares), 3_000_000n);
    await publish(limit);
    await publish(shaped);
    let [spendable, committed, available, orders] = await onChainBudget(marketA, usdc);
    assert.deepEqual([spendable, committed, available, orders], [7_000_000n, 7_000_000n, 0n, 2n]);

    // The API computes the same figures independently, from the same registry.
    const api = await service.marketBudgets(maker, marketA);
    assert.equal(api.usdc.spendable, spendable);
    assert.equal(api.usdc.committed, committed);
    assert.equal(api.usdc.available, available);
    assert.equal(api.usdc.orders.length, 2);
    assert.equal(api.usdc.overcommitted, false);
    assert.equal(api.yes.committed, 0n);
    assert.equal(api.no.committed, 0n);

    // ---- one base unit over the limit is refused, on chain and in the API ----------------------
    await refuses(curve(marketA, 7, 1, 1, 1_000_000n, 3));
    const oneUnitMore = { maker, market: marketA, isYes: true, isBuy: true,
      startPrice: 1, endPrice: 1, shares: 1_000_000n, shape: 1 };
    const rejected = await service.preparePublication(oneUnitMore);
    assert.equal(rejected.budget.fits, false);
    assert.equal(rejected.budget.requested, 1n, 'one share at the smallest price owes one base unit');
    assert.equal(rejected.budget.shortfall, 1n);
    assert.equal(rejected.budget.committed, 7_000_000n);
    // The wallet holds plenty; it is the Aqua approval that leaves no room, and the approval this
    // order needs covers what the market already commits as well as itself.
    assert.equal(rejected.readiness, 'approval_required');
    assert.equal(rejected.budget.required, 7_000_001n);
    assert.equal(rejected.approval.amount, '7000001');

    // ---- markets hold independent budgets over the same shared wallet --------------------------
    await publish(curve(marketB, 7, 400_000, 400_000, 17_500_000n, 4));
    const inB = await onChainBudget(marketB, usdc);
    assert.equal(inB[1], 7_000_000n);
    assert.equal((await onChainBudget(marketA, usdc))[1], 7_000_000n, 'market B never reduced market A');

    // ---- a fill moves the commitment and the wallet by the same amount -------------------------
    const legs = [{ maker, strategy: shaped, shares: 1_000_000n, expectedFilled: 0n }];
    const request = { market: marketA, isYes: true, isBuy: true, shares: 1_000_000n, limit: 1_000_000n,
      recipient: taker, deadline: Number(block.timestamp + 86_000n) };
    await write(taker, executor, routeAbi, 'execute', [request, legs]);
    // The integral over the first share of a 0.40 → 0.20 linear curve, not its opening price.
    const spent = cumulative(shaped, 1_000_000n);
    assert.equal(spent, 390_000n);
    const filled = await service.marketBudgets(maker, marketA);
    assert.equal(filled.usdc.committed, 7_000_000n - spent, 'a fill is not a cancellation');
    assert.equal(filled.usdc.spendable, 7_000_000n - spent);
    assert.equal(filled.usdc.available, 0n, 'both sides moved together, so no room appeared');

    // ---- cancelling releases the whole remaining commitment ------------------------------------
    const shapedHash = keccak256(await encode(shaped));
    const outcomeOfShaped = await client.readContract({ address: router, abi: routerAbi, functionName: 'curveOutcome', args: [shaped] }) as Address;
    await write(maker, aqua, aquaAbi, 'dock', [router, shapedHash, [outcomeOfShaped, usdc]]);
    const afterCancel = await service.marketBudgets(maker, marketA);
    assert.equal(afterCancel.usdc.committed, 4_000_000n);
    assert.equal(afterCancel.usdc.orders.length, 1);
    assert.equal(afterCancel.usdc.available, 7_000_000n - spent - 4_000_000n);

    // ---- shrinking the funding leaves the market over budget -----------------------------------
    // A reduced allowance and a reduced balance have the same effect on the budget, and the API
    // names the one a maker can act on: approve more, or add funds.
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 1_000_000n]);
    const short = await service.marketBudgets(maker, marketA);
    assert.equal(short.usdc.spendable, 1_000_000n);
    assert.equal(short.usdc.committed, 4_000_000n, 'an underfunded wallet must not release a commitment');
    assert.equal(short.usdc.available, 0n);
    assert.equal(short.usdc.overcommitted, true);
    await refuses(curve(marketA, 7, 1, 1, 1_000_000n, 5));

    const held = await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [maker] }) as bigint;
    await write(maker, usdc, erc20Abi, 'transfer', [owner, held - 1_000_000n]);
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 100_000_000n]);
    const drained = await service.preparePublication({ maker, market: marketA, isYes: true, isBuy: true,
      startPrice: 1, endPrice: 1, shares: 1_000_000n, shape: 1 });
    // The money itself is gone, and this market already commits four USDC of it: an approval would
    // not help, so the refusal says the market is over budget rather than asking for one.
    assert.equal(drained.readiness, 'over_budget');
    assert.equal(drained.budget.balance, 1_000_000n);
    assert.equal(drained.budget.committed, 4_000_000n);
    assert.equal(drained.budget.overcommitted, true);
    await write(owner, usdc, token.abi, 'mint', [maker, 100_000_000n]);
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 7_000_000n]);

    // ---- two publications cannot both pass one budget ------------------------------------------
    // Both are prepared and shipped while neither is admitted, exactly as two concurrent requests
    // through the API would be. The first admission lands; the second reads it and is refused.
    const raceA = curve(marketB, 6, 300_000, 300_000, 10_000_000n, 6);
    const raceB = curve(marketB, 7, 300_000, 300_000, 10_000_000n, 7);
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 10_000_000n]);
    const bothPrepared = await Promise.all([
      service.preparePublication({ maker, market: marketB, isYes: false, isBuy: true, startPrice: 300_000, endPrice: 300_000, shares: 10_000_000n, shape: 1 }),
      service.preparePublication({ maker, market: marketB, isYes: true, isBuy: true, startPrice: 300_000, endPrice: 300_000, shares: 10_000_000n, shape: 1 }),
    ]);
    // Market B already commits 7 USDC, so a stale check would let both of these 3 USDC orders pass.
    assert.equal(bothPrepared[0].readiness, 'ready');
    assert.equal(bothPrepared[1].readiness, 'ready');
    await ship(raceA);
    await ship(raceB);
    await admit(raceA);
    await assert.rejects(client.simulateContract({ address: router, abi: routerAbi, functionName: 'admitCurve', args: [raceB], account: maker }));
    assert.equal((await onChainBudget(marketB, usdc))[1], 10_000_000n);

    // ---- the bypass: an order shipped straight to Aqua, never admitted -------------------------
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 50_000_000n]);
    const bypass = curve(marketA, 6, 400_000, 400_000, 10_000_000n, 8);
    const bypassHash = await ship(bypass);
    const [allocation] = await client.readContract({ address: aqua, abi: aquaAbi, functionName: 'rawBalances',
      args: [maker, router, bypassHash, usdc] }) as readonly [bigint, number];
    assert.equal(allocation, 4_000_000n, 'Aqua accepted the publication, as it will for anyone');
    assert.equal(await client.readContract({ address: ledger, abi: orderBudgetAbi, functionName: 'isAdmitted', args: [bypassHash] }), false);
    // It consumes no budget, because it can spend nothing.
    assert.equal((await service.marketBudgets(maker, marketA)).usdc.orders.every(order => order.orderHash !== bypassHash), true);
    // And it cannot be routed against, at the executor or through the quote service.
    await assert.rejects(client.simulateContract({ address: executor, abi: routeAbi, functionName: 'execute',
      args: [{ ...request, deadline: Number(block.timestamp + 86_000n) }, [{ maker, strategy: bypass, shares: 1_000_000n, expectedFilled: 0n }]],
      account: taker }));

    // The quote service discovers it through the indexer and still refuses to route against it.
    const indexed = [{ id: bypassHash, maker, market: { id: marketA }, flags: bypass.flags,
      startPrice: String(bypass.startPrice), endPrice: String(bypass.endPrice),
      maxShares: String(bypass.maxShares), salt: bypass.salt }];
    graph.on('request', async (_req, res) => {
      const head = await client.getBlock();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { _meta: { block: { number: Number(head.number), hash: head.hash }, hasIndexingErrors: false }, strategies: indexed } }));
    });
    await new Promise<void>(resolve => graph.listen(0, '127.0.0.1', resolve));
    const graphPort = (graph.address() as { port: number }).port;
    const quotes = new QuoteService({ ...config, graph: `http://127.0.0.1:${graphPort}` });
    await assert.rejects(quotes.quote({ market: marketA, account: taker, recipient: taker, isYes: true, isBuy: true,
      shares: 1_000_000n, slippageBps: 50 }), /insufficient_executable_liquidity/);

    // ---- a router without the registry fails closed rather than reporting an empty budget -------
    const blind = new MarketService({ ...config, router: usdc });
    await assert.rejects(blind.marketBudgets(maker, marketA), (error: unknown) =>
      error instanceof MarketError && error.message === 'order_budget_unavailable');
    await assert.rejects(blind.preparePublication({ maker, market: marketA, isYes: true, isBuy: true,
      startPrice: 400_000, endPrice: 400_000, shares: 1_000_000n, shape: 1 }));

    // ---- sell inventories are separate budgets, and separate from USDC -------------------------
    await write(owner, usdc, token.abi, 'mint', [owner, 20_000_000n]);
    await write(owner, usdc, erc20Abi, 'approve', [marketA, 20_000_000n]);
    await write(owner, marketA, marketAbi, 'mintPair', [20_000_000n, maker, maker]);
    const noToken = await client.readContract({ address: marketA, abi: marketAbi, functionName: 'noToken' }) as Address;
    await write(maker, yesToken, erc20Abi, 'approve', [aqua, 10_000_000n]);
    await write(maker, noToken, erc20Abi, 'approve', [aqua, 10_000_000n]);
    await publish(curve(marketA, 5, 600_000, 800_000, 10_000_000n, 9));
    const sells = await service.marketBudgets(maker, marketA);
    assert.equal(sells.yes.committed, 10_000_000n);
    assert.equal(sells.yes.available, 0n);
    assert.equal(sells.no.committed, 0n, 'NO inventory is a different budget entirely');
    assert.equal(sells.no.available, 10_000_000n);
    assert.equal(sells.usdc.committed, 4_000_000n, 'selling inventory never touched the USDC budget');
    // A second YES sell has no inventory left, while a NO sell of the same size is accepted.
    await refuses(curve(marketA, 5, 600_000, 800_000, 1_000_000n, 10));
    await publish(curve(marketA, 4, 600_000, 800_000, 10_000_000n, 11));
    assert.equal((await service.marketBudgets(maker, marketA)).no.committed, 10_000_000n);
  } finally {
    await new Promise<void>(resolve => { if (graph.listening) graph.close(() => resolve()); else resolve(); });
    anvil.kill('SIGTERM');
  }
});
