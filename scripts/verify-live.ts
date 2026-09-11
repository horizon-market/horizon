import { readFile } from 'node:fs/promises';
import { loadConfig, databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { decodeEvents } from '../src/stream/events.js';
import { processBlock, STREAM_CHECKPOINT } from '../src/stream/processor.js';
import { syncMarkets } from '../src/trading/projection.js';
import { GraphProvider } from '../src/trading/graph.js';

/**
 * Acceptance check for the live layer, against a running API.
 *
 * The claim under test: with the periodic sync stopped, a market that was just created and a
 * trade that was just executed are visible — in the list, on the market page, in its history and
 * as the creator's notice — because the stream recorded them; and when the sync runs again, the
 * reader sees exactly the same thing.
 *
 *   npm run verify:live -- --api http://127.0.0.1:3001 --watch 0xTxHash        # a live consumer is running;
 *                                                                              # wait for it to record this transaction
 *   npm run verify:live -- --api http://127.0.0.1:3001 --replay test/fixtures/substreams/sepolia-phase2.json
 *                                                                              # no credential at hand: feed recorded
 *                                                                              # blocks through the same processor
 *
 * Run it with the worker stopped, or with MARKET_SYNC_ENABLED=false on the API, so the first
 * reads cannot be answered by a sweep. `--sweep` then runs one sweep from The Graph and compares.
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const api = (flag('api') ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const watch = flag('watch'), replay = flag('replay'), sweep = args.includes('--sweep');
if (!watch && !replay) throw new Error('Pass --watch 0xTxHash (live consumer) or --replay <fixture.json>.');
const config = loadConfig();
const db = createDatabase(databaseUrl());
await db.$connect();
const get = async <T>(path: string) => {
  const response = await fetch(`${api}${path}`);
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json() as Promise<T>;
};
const check = (condition: unknown, label: string) => { console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`); if (!condition) process.exitCode = 1; };

try {
  const live = await get<{ live: { available: boolean } }>('/api/config');
  console.log(`API ${api}: live.available=${live.live.available}; sync ${config.marketSync.enabled ? 'ENABLED — stop the worker for a meaningful run' : 'disabled'}`);
  let markets: string[] = [], txHash: string | undefined;
  if (replay) {
    const fixture = JSON.parse(await readFile(replay, 'utf8')) as { blocks: { number: number; hash: string; timestamp: number; output: unknown }[] };
    for (const block of fixture.blocks) {
      const { events } = decodeEvents(block.output);
      const report = await processBlock({ db }, { number: block.number, hash: block.hash, timestamp: block.timestamp, cursor: `replay-${block.number}`, finalBlock: block.number - 64, events });
      console.log('replayed', report);
      for (const event of events) {
        if (event.kind === 'MARKET_CREATED') markets.push(event.data.market);
        if (event.kind === 'ROUTE_EXECUTED') { txHash = event.txHash; if (!markets.includes(event.data.market)) markets.push(event.data.market); }
      }
    }
  } else {
    txHash = watch!.toLowerCase();
    console.log(`Waiting for the consumer to record ${txHash} …`);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const rows = await db.liveChange.findMany({ where: { txHash } });
      const trade = await db.trade.findFirst({ where: { txHash } });
      if (rows.length || trade) { markets = [...new Set([...rows.map(row => row.market), ...(trade ? [trade.market] : [])])]; break; }
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    check(markets.length > 0, 'the consumer recorded the transaction');
  }
  const checkpoint = await db.streamCheckpoint.findUnique({ where: { id: STREAM_CHECKPOINT } });
  check(checkpoint, `stream checkpoint at block ${checkpoint?.blockNumber}`);

  const before = new Map<string, unknown>();
  for (const market of markets) {
    const list = await get<{ markets: { id: string }[]; liveBlock: number | null }>('/api/markets');
    check(list.markets.some(row => row.id.toLowerCase() === market), `${market} is listed (liveBlock ${list.liveBlock})`);
    const detail = await get<{ market: { question: string; liquidity: unknown; curves: unknown[] }; liveBlock: number | null }>(`/api/markets/${market}`).catch(error => { check(false, `${market} detail: ${error}`); return null; });
    if (detail) console.log(`     "${detail.market.question}" — ${detail.market.curves.length} executable curves, liquidity ${JSON.stringify(detail.market.liquidity)}`);
    const trades = await get<{ trades: { transaction: string; fills: number; source: string }[] }>(`/api/markets/${market}/trades`);
    if (txHash) check(trades.trades.some(trade => trade.transaction.toLowerCase() === txHash), `${market} history holds the trade (${trades.trades.length} trades)`);
    before.set(market, { detail: detail?.market, trades: trades.trades.map(trade => trade.transaction) });
  }
  const notices = await db.notification.findMany({ where: { marketAddress: { in: markets } } });
  console.log(`     ${notices.length} creator notice(s): ${notices.map(notice => `${notice.title} [${notice.sources.join('+')}]`).join('; ') || 'none (no creation request matches these markets)'}`);

  if (sweep) {
    if (!config.trading) throw new Error('--sweep needs trading configuration (GRAPH_QUERY_URL etc.)');
    const report = await syncMarkets(db, new GraphProvider(config.trading.graph, config.trading.graphKey));
    console.log('sweep', report);
    for (const market of markets) {
      const detail = await get<{ market: { question: string; liquidity: unknown; curves: unknown[] } }>(`/api/markets/${market}`).catch(() => null);
      const trades = await get<{ trades: { transaction: string }[] }>(`/api/markets/${market}/trades`);
      const earlier = before.get(market) as { detail: unknown; trades: string[] };
      check(JSON.stringify(detail?.market) === JSON.stringify(earlier.detail), `${market} reads the same after the sweep`);
      check(JSON.stringify(trades.trades.map(trade => trade.transaction)) === JSON.stringify(earlier.trades), `${market} history is the same after the sweep`);
    }
  }
} finally {
  await db.$disconnect();
}
