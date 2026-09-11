import { writeFile } from 'node:fs/promises';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { sepolia } from 'viem/chains';

/**
 * Records what `map_horizon_events` would emit for a block range, from the chain itself.
 *
 * The output is the module's protobuf-JSON shape, one entry per block, decoded from the receipts
 * of transactions Horizon knows about with the same address filters the Rust module applies. It is what the integration tests replay
 * and what `verify:live` can feed the processor when no Substreams credential is at hand — so the
 * consumer is exercised on real Sepolia data without a live stream.
 *
 *   npm run substreams:fixture -- --out test/fixtures/substreams/sepolia.json [--limit 60] [0xTxHash …]
 *   npm run substreams:fixture -- --router 0x… --executor 0x… --out … 0xTxHash …   # a superseded router's trades
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const rpc = process.env.EVM_RPC_URL;
if (!rpc) throw new Error('EVM_RPC_URL is required');
const deployment = JSON.parse(await (await import('node:fs/promises')).readFile('deployments/sepolia.json', 'utf8')) as Record<string, string>;
// `--router` / `--executor` record a superseded deployment's transactions with its own addresses.
const registry = deployment.registry as Address, router = (flag('router') ?? deployment.router) as Address, executor = (flag('executor') ?? deployment.executor) as Address, aqua = deployment.aqua as Address;
const client = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 30_000 }) });
const head = await client.getBlockNumber();
const out = flag('out') ?? 'test/fixtures/substreams/sepolia.json';

const abi = parseAbi([
  'event MarketCreated(bytes32 indexed creationId,address indexed market,address indexed resolver,address yesToken,address noToken,uint40 closeAt,string question,string rules,string evidenceSource)',
  'event CurveFilled(bytes32 indexed orderHash,address indexed market,address indexed maker,uint256 shares,uint256 usdcAmount,uint256 totalFilled)',
  'event StrategyAdmitted(bytes32 indexed orderHash,address indexed market,address indexed maker,address token,uint256 commitment,uint256 committedBefore,uint256 spendable)',
  'event RouteExecuted(address indexed market,address indexed taker,address indexed recipient,bool isYes,bool isBuy,uint256 shares,uint256 usdcAmount,uint256 fills)',
  'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
  'event Docked(address maker,address app,bytes32 strategyHash)',
  'event CollateralChanged(uint256 collateral)',
  'event MarketResolved(uint8 result,address indexed resolver,string evidence)',
]);
const lower = (value: string) => value.toLowerCase();
type Entry = Record<string, unknown>;
const blocks = new Map<bigint, Entry[]>();
const timestamps = new Map<bigint, { hash: string; timestamp: number }>();
const push = async (log: { blockNumber: bigint; blockHash: `0x${string}`; transactionHash: `0x${string}`; logIndex: number; transactionIndex: number; address: Address }, kind: string, member: string, data: Entry) => {
  if (!timestamps.has(log.blockNumber)) {
    const block = await client.getBlock({ blockNumber: log.blockNumber });
    timestamps.set(log.blockNumber, { hash: block.hash, timestamp: Number(block.timestamp) });
  }
  const block = timestamps.get(log.blockNumber)!;
  const list = blocks.get(log.blockNumber) ?? [];
  list.push({ kind, contract: lower(log.address), blockNumber: log.blockNumber.toString(), blockHash: block.hash, blockTimestamp: String(block.timestamp),
    txHash: log.transactionHash, logIndex: log.logIndex, txIndex: log.transactionIndex, [member]: data });
  blocks.set(log.blockNumber, list);
};
// Public RPCs cap eth_getLogs to a handful of blocks, so the recording is driven by transactions
// Horizon already knows: its own creation and resolution broadcasts, and the routes and fills the
// Subgraph indexed. Each receipt is decoded with the module's address filters.
const hashes = new Set<string>(args.filter(value => /^0x[0-9a-fA-F]{64}$/.test(value)).map(lower));
const limit = Number(flag('limit') ?? '60');
if (process.env.DATABASE_URL && limit > 0) {
  const { createDatabase } = await import('../src/db.js');
  const db = createDatabase(process.env.DATABASE_URL);
  for (const row of await db.creationRequest.findMany({ where: { creationTxHash: { not: null } }, select: { creationTxHash: true }, take: limit })) hashes.add(lower(row.creationTxHash!));
  for (const row of await db.creationChild.findMany({ where: { creationTxHash: { not: null } }, select: { creationTxHash: true }, take: limit })) hashes.add(lower(row.creationTxHash!));
  for (const row of await db.marketResolution.findMany({ where: { txHash: { not: null } }, select: { txHash: true }, take: limit })) hashes.add(lower(row.txHash!));
  await db.$disconnect();
}
if (process.env.GRAPH_QUERY_URL && limit > 0) {
  const { GraphProvider } = await import('../src/trading/graph.js');
  const activity = await new GraphProvider(process.env.GRAPH_QUERY_URL, process.env.GRAPH_API_KEY).activity(undefined, limit);
  for (const route of activity.routes) hashes.add(lower(route.transaction));
  for (const fill of activity.fills) hashes.add(lower(fill.transaction));
}
const { decodeEventLog } = await import('viem');
const markets = new Set<string>();
const receipts = [];
for (const hash of hashes) receipts.push(await client.getTransactionReceipt({ hash: hash as `0x${string}` }));
receipts.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.transactionIndex - b.transactionIndex);
// Two passes: markets are learned from MarketCreated first, so their own events pass the filter.
for (const receipt of receipts) for (const log of receipt.logs) {
  if (lower(log.address) === lower(registry)) try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (decoded.eventName === 'MarketCreated') markets.add(lower(decoded.args.market));
  } catch { /* not ours */ }
}
for (const receipt of receipts) for (const log of receipt.logs) {
  const address = lower(log.address);
  const at = { blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex, transactionIndex: log.transactionIndex, address: log.address };
  let decoded;
  try { decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { continue; }
  const a = decoded.args as Record<string, unknown>;
  if (address === lower(registry) && decoded.eventName === 'MarketCreated') {
    await push(at, 'MARKET_CREATED', 'marketCreated', { creationId: a.creationId, market: lower(a.market as string), resolver: lower(a.resolver as string), yesToken: lower(a.yesToken as string),
      noToken: lower(a.noToken as string), closeAt: String(a.closeAt), question: a.question, rules: a.rules, evidenceSource: a.evidenceSource });
  } else if (address === lower(router) && decoded.eventName === 'CurveFilled') {
    await push(at, 'CURVE_FILLED', 'curveFilled', { orderHash: a.orderHash, market: lower(a.market as string), maker: lower(a.maker as string), shares: String(a.shares), usdcAmount: String(a.usdcAmount), totalFilled: String(a.totalFilled) });
  } else if (address === lower(router) && decoded.eventName === 'StrategyAdmitted') {
    await push(at, 'STRATEGY_ADMITTED', 'strategyAdmitted', { orderHash: a.orderHash, market: lower(a.market as string), maker: lower(a.maker as string), token: lower(a.token as string),
      commitment: String(a.commitment), committedBefore: String(a.committedBefore), spendable: String(a.spendable) });
  } else if (address === lower(executor) && decoded.eventName === 'RouteExecuted') {
    await push(at, 'ROUTE_EXECUTED', 'routeExecuted', { market: lower(a.market as string), taker: lower(a.taker as string), recipient: lower(a.recipient as string), isYes: a.isYes, isBuy: a.isBuy,
      shares: String(a.shares), usdcAmount: String(a.usdcAmount), fills: String(a.fills) });
  } else if (address === lower(aqua) && (decoded.eventName === 'Shipped' || decoded.eventName === 'Docked') && lower(a.app as string) === lower(router)) {
    if (decoded.eventName === 'Shipped') await push(at, 'SHIPPED', 'shipped', { maker: lower(a.maker as string), app: lower(a.app as string), strategyHash: a.strategyHash, strategy: a.strategy });
    else await push(at, 'DOCKED', 'docked', { maker: lower(a.maker as string), app: lower(a.app as string), strategyHash: a.strategyHash });
  } else if (markets.has(address) && decoded.eventName === 'CollateralChanged') {
    await push(at, 'COLLATERAL_CHANGED', 'collateralChanged', { market: address, collateral: String(a.collateral) });
  } else if (markets.has(address) && decoded.eventName === 'MarketResolved') {
    await push(at, 'MARKET_RESOLVED', 'marketResolved', { market: address, result: Number(a.result), resolver: lower(a.resolver as string), evidence: a.evidence });
  }
}
const recorded = [...blocks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([number, events]) => {
  const block = timestamps.get(number)!;
  events.sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
  return { number: Number(number), hash: block.hash, timestamp: block.timestamp, output: { events } };
});
await writeFile(out, JSON.stringify({ network: 'sepolia', router: lower(router), executor: lower(executor), recordedAt: new Date().toISOString(), head: Number(head), transactions: [...hashes].sort(), blocks: recorded }, null, 2) + '\n');
console.log(`Recorded ${recorded.length} blocks with ${recorded.reduce((sum, block) => sum + block.output.events.length, 0)} events from ${hashes.size} transactions into ${out}.`);
