import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

async function main() {
  const key = process.env.GRAPH_DEPLOY_KEY, slug = process.env.GRAPH_SUBGRAPH_SLUG;
  if (!key || !slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Missing or invalid Studio configuration');
  // Studio refuses to reuse a version label, and a schema change needs a full re-index anyway, so
  // this is a parameter rather than a constant. Bump it whenever the entities or the router change.
  const version = process.env.GRAPH_SUBGRAPH_VERSION || '0.3.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid GRAPH_SUBGRAPH_VERSION');
  const deployment = JSON.parse(await readFile('deployments/sepolia.json', 'utf8')) as { router?: string };
  if (!deployment.router) throw new Error('Deploy contracts first');
  const child = spawn(process.execPath, ['node_modules/@graphprotocol/graph-cli/bin/run.js', 'deploy', slug,
    'subgraph/subgraph.yaml', '--node', 'https://api.studio.thegraph.com/deploy/', '--deploy-key', key,
    '--version-label', version, '--output-dir', 'subgraph/build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  output = output.replaceAll(key, '[redacted]').replace(/\u001b\[[0-9;]*m/g, '');
  await mkdir('.local', { recursive: true }); await writeFile('.local/graph-deploy.log', output, { mode: 0o600 });
  if (code !== 0) throw new Error('Graph deployment failed; sanitized details are in .local/graph-deploy.log');
  const queryUrl = output.match(/https:\/\/api\.studio\.thegraph\.com\/query\/[\w/.-]+/)?.[0];
  if (!queryUrl) throw new Error('Deployment succeeded but query URL was not found in CLI output');
  await writeFile('deployments/graph.json', JSON.stringify({ slug, version, queryUrl, deployedAt: new Date().toISOString() }, null, 2) + '\n');
  let env = await readFile('.env', 'utf8');
  env = /^GRAPH_QUERY_URL=.*$/m.test(env) ? env.replace(/^GRAPH_QUERY_URL=.*$/m, `GRAPH_QUERY_URL=${queryUrl}`) : `${env.trimEnd()}\nGRAPH_QUERY_URL=${queryUrl}\n`;
  await writeFile('.env', env, { mode: 0o600 });
  console.log(`Subgraph deployed: ${queryUrl}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Graph deployment failed'); process.exitCode = 1; });
