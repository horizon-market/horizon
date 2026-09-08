import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, erc20Abi, encodeAbiParameters, parseAbiParameters, keccak256, type Abi, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { routerAbi, routeAbi, registryAbi, marketAbi, aquaAbi } from '../src/trading/abi.js';
import { cumulative, type Curve } from '../src/trading/math.js';
import { QuoteService } from '../src/trading/service.js';

test('real EVM: TypeScript arithmetic, indexed discovery, simulation, two fills, and stale rejection', { timeout: 90_000 }, async () => {
  const port = 18547;
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '11155111', '--silent'], { stdio: 'ignore' });
  const rpc = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) });
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpc) });
  const graph = createServer();
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (anvil.exitCode !== null) throw new Error('Anvil exited; ensure port 18547 is free');
      try { await client.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready);
    const [owner, maker, taker] = await wallet.getAddresses();
    assert.ok(owner && maker && taker);
    const deploy = async (name: string, args: unknown[] = []) => {
      const a = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
      const tx = await wallet.deployContract({ account: owner, abi: a.abi, bytecode: a.bytecode.object, args });
      const receipt = await client.waitForTransactionReceipt({ hash: tx }); assert.equal(receipt.status, 'success'); return receipt.contractAddress!;
    };
    const write = async (account: Address, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
      const tx = await wallet.writeContract({ account, address, abi, functionName, args });
      const receipt = await client.waitForTransactionReceipt({ hash: tx }); assert.equal(receipt.status, 'success'); return receipt;
    };
    const tokenArtifact = JSON.parse(await readFile('contracts/out/TestBase.sol/TestUSDC.json', 'utf8')) as { abi: Abi; bytecode: { object: Hex } };
    const mintTx = await wallet.deployContract({ account: owner, abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object });
    const usdc = (await client.waitForTransactionReceipt({ hash: mintTx })).contractAddress!;
    const aqua = await deploy('Aqua'); const registry = await deploy('MarketRegistry', [usdc, owner]);
    const router = await deploy('HorizonSwapVM', [aqua, registry, owner]); const executor = await deploy('RouteExecutor', [router]);
    const block = await client.getBlock(); const id = keccak256('0x1234');
    await write(owner, registry, registryAbi, 'createMarket', [id, 'Local integration?', 'Test rules', 'Test evidence', Number(block.timestamp + 86400n), owner]);
    const market = await client.readContract({ address: registry, abi: registryAbi, functionName: 'marketByCreationId', args: [id] });
    const no = await client.readContract({ address: market, abi: marketAbi, functionName: 'noToken' });
    for (const account of [maker, taker]) await write(owner, usdc, tokenArtifact.abi, 'mint', [account, 10_000_000n]);
    await write(maker, usdc, erc20Abi, 'approve', [aqua, 10_000_000n]);
    await write(taker, usdc, erc20Abi, 'approve', [executor, 10_000_000n]);
    const strategies: Record<string, unknown>[] = [];
    for (let i = 1; i <= 2; i++) {
      const strategy: Curve = { market, flags: 2 + 4 * i, startPrice: 450000, endPrice: 350000, maxShares: 1_000_000n, salt: keccak256(`0x0${i}`) };
      for (const q of [1n, 12345n, 500001n, 1_000_000n]) {
        const actual = await client.readContract({ address: router, abi: routerAbi, functionName: 'curveCumulative', args: [strategy, q] });
        assert.equal(actual, cumulative(strategy, q));
      }
      const order = await client.readContract({ address: router, abi: routerAbi, functionName: 'buildCurveOrder', args: [maker, strategy] });
      const encoded = encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'), [order]);
      await write(maker, aqua, aquaAbi, 'ship', [router, encoded, [no, usdc], [0n, cumulative(strategy, strategy.maxShares)]]);
      strategies.push({ id: keccak256(encoded), maker, market: { id: market }, flags: strategy.flags, startPrice: String(strategy.startPrice), endPrice: String(strategy.endPrice), maxShares: String(strategy.maxShares), salt: strategy.salt });
    }
    let badHash = false;
    graph.on('request', async (_req, res) => { const b = await client.getBlock(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: {
      _meta: { block: { number: Number(b.number), hash: badHash ? keccak256('0x12') : b.hash }, hasIndexingErrors: false }, strategies,
    } })); });
    await new Promise<void>(resolve => graph.listen(0, '127.0.0.1', resolve));
    const graphPort = (graph.address() as { port: number }).port;
    const service = new QuoteService({ rpc, graph: `http://127.0.0.1:${graphPort}`, router, executor, registry, aqua, usdc });
    const input = { market, account: taker, recipient: taker, isYes: true, isBuy: true, shares: 2_000_000n, slippageBps: 50 };
    const quote = await service.quote(input);
    assert.equal(quote.simulation, 'passed'); assert.equal(quote.legs.length, 2);
    const receipt = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: taker, to: executor, data: quote.transaction.data }) });
    assert.equal(receipt.status, 'success');
    const yes = await client.readContract({ address: market, abi: marketAbi, functionName: 'yesToken' });
    assert.equal(await client.readContract({ address: yes, abi: erc20Abi, functionName: 'balanceOf', args: [taker] }), 2_000_000n);
    await assert.rejects(client.call({ account: taker, to: executor, data: quote.transaction.data }));
    await assert.rejects(service.quote(input), /insufficient/);
    badHash = true; await assert.rejects(service.quote(input), /graph_reorg/);
  } finally {
    await new Promise<void>(resolve => { if (graph.listening) graph.close(() => resolve()); else resolve(); });
    anvil.kill('SIGTERM');
  }
});
