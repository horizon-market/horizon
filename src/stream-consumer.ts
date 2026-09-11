import { createPublicClient, http, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { loadConfig, databaseUrl } from './config.js';
import { createDatabase } from './db.js';
import { routerAbi } from './trading/abi.js';
import { processBlock, prune, undoTo, STREAM_CHECKPOINT, type DecodedCurve } from './stream/processor.js';
import { describeStreamError, runStream } from './stream/substreams.js';

/**
 * The third Horizon process. It holds one Substreams connection open, records every block's
 * Horizon events in one transaction with the cursor, and wakes the API through Postgres so open
 * pages update. It never touches the market mirror: the sync worker owns that, and this process
 * owns the live layer beside it.
 */
const config = loadConfig();
if (!config.stream.enabled) {
  console.log('Stream consumer idle: STREAM_ENABLED is not true.');
  process.exit(0);
}
if (!config.stream.token && !config.stream.apiKey) throw new Error('Set SUBSTREAMS_API_TOKEN or SUBSTREAMS_API_KEY; see .env.example.');
const db = createDatabase(databaseUrl());
await db.$connect();

// Aqua strategy bytes are the router's own encoding; the router is what can say whether they are
// one of its curve orders, and for which maker. Without trading configuration shipped orders are
// simply not mirrored until the next sync sweep.
const trading = config.trading;
const client = trading ? createPublicClient({ chain: sepolia, transport: http(trading.rpc, { timeout: 15_000, retryCount: 1 }) }) : undefined;
const decodeCurve = trading && client ? async (strategy: Hex, maker: Address, strategyHash: Hex): Promise<DecodedCurve | null> => {
  try {
    const [curve, owner, orderHash] = await client.readContract({ address: trading.router, abi: routerAbi, functionName: 'decodeCurveOrder', args: [strategy] });
    if (owner.toLowerCase() !== maker.toLowerCase() || orderHash.toLowerCase() !== strategyHash.toLowerCase()) return null;
    return { market: curve.market, flags: Number(curve.flags), startPrice: Number(curve.startPrice), endPrice: Number(curve.endPrice), maxShares: curve.maxShares, salt: curve.salt };
  } catch { return null; }
} : undefined;

const controller = new AbortController();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
  clearInterval(housekeeping);
  await db.$disconnect();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

const housekeeping = setInterval(() => {
  prune(db).catch(error => console.error('Live layer pruning failed', describeStreamError(error)));
}, 10 * 60_000);
housekeeping.unref();

let attempt = 0;
while (!stopping) {
  const checkpoint = await db.streamCheckpoint.findUnique({ where: { id: STREAM_CHECKPOINT } });
  const cursor = checkpoint?.cursor || undefined;
  console.log(`Stream consumer connecting: module ${config.stream.module}, ${cursor ? `resuming after block ${checkpoint!.blockNumber}` : `from block ${config.stream.startBlock}`}`);
  try {
    await runStream(config.stream, cursor, {
      onBlock: async block => {
        attempt = 0;
        const report = await processBlock({ db, decodeCurve }, block);
        if (block.dropped) console.error('Stream events dropped: missing payload', { block: block.number, dropped: block.dropped });
        if (report.events > 0) console.log('Stream block recorded', report);
      },
      onUndo: async lastValid => {
        const report = await undoTo({ db }, lastValid);
        console.log('Stream reorg applied', report);
      },
    }, controller.signal);
    if (!stopping) console.log('Stream ended; reconnecting');
  } catch (error) {
    if (stopping) break;
    console.error('Stream failed; reconnecting', describeStreamError(error));
  }
  if (stopping) break;
  // Exponential backoff to a minute: a broken package or credential must not hammer the endpoint.
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempt++, 6));
  await new Promise(resolve => setTimeout(resolve, delay));
}
