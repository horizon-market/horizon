import { readFile, writeFile } from 'node:fs/promises';
import { GraphProvider } from '../src/trading/graph.js';

async function main() {
  const evidence = JSON.parse(await readFile('deployments/phase2-evidence.json', 'utf8')) as { transaction: string; completed: boolean };
  if (!evidence.completed) throw new Error('Live route verification incomplete');
  const graph = new GraphProvider(process.env.GRAPH_QUERY_URL!, process.env.GRAPH_API_KEY);
  const data = await graph.query(`query Evidence($tx: Bytes!) {
    _meta { block { number hash } hasIndexingErrors }
    routes(first: 5, where: { transaction: $tx }) { id market { id collateral } taker recipient shares usdc fills block transaction }
    fills(first: 5, where: { transaction: $tx }) { id strategy { id filled active } shares usdc block transaction }
  }`, { tx: evidence.transaction }) as {
    _meta: { hasIndexingErrors: boolean; block: { number: number } };
    routes: { shares: string; fills: string; market: { collateral: string } }[];
    fills: { shares: string; strategy: { active: boolean } }[];
  };
  if (data._meta.hasIndexingErrors || data.routes.length !== 1 || data.fills.length !== 2
    || data.routes[0]!.shares !== '2000000' || data.routes[0]!.fills !== '2'
    || data.routes[0]!.market.collateral !== '2000000'
    || data.fills.some(f => f.shares !== '1000000' || f.strategy.active)) throw new Error('Indexed result not ready or inconsistent');
  await writeFile('deployments/phase2-indexed.json', JSON.stringify({ verifiedAt: new Date().toISOString(), ...data }, null, 2) + '\n');
  console.log(`Live Graph verified: one atomic route, two fills, 2 USDC collateral, exhausted curves inactive; indexed block ${data._meta.block.number}.`);
}
main().catch(() => { console.error('Indexed evidence not ready or unavailable; retry after indexing catches up. No secrets logged.'); process.exitCode = 1; });
