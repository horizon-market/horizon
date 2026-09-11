import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Builds and packs the `horizon_events` Substreams module.
 *
 * The manifest's `params` and `initialBlock` are written from `deployments/sepolia.json`, so the
 * stream and the Subgraph always name the same contracts. Needs the Rust toolchain with the
 * `wasm32-unknown-unknown` target and the `substreams` CLI; each missing tool is reported by name.
 *
 *   npm run substreams:pack            # protogen + cargo build + pack, writes deployments/substreams.json
 *   npm run substreams:pack -- --manifest-only   # only rewrite substreams.yaml
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const manifestOnly = process.argv.includes('--manifest-only');
const deployment = JSON.parse(await readFile('deployments/sepolia.json', 'utf8')) as Record<string, string>;
const addresses = { registry: deployment.registry, router: deployment.router, executor: deployment.executor, aqua: deployment.aqua };
for (const [name, value] of Object.entries(addresses)) {
  if (!value || !ADDRESS.test(value)) throw new Error(`deployments/sepolia.json has no ${name} address`);
}
const startBlock = Number(deployment.startBlock ?? '0');
if (!Number.isInteger(startBlock) || startBlock < 0) throw new Error('deployments/sepolia.json has no startBlock');
const params = Object.entries(addresses).map(([name, value]) => `${name}=${value!.toLowerCase()}`).join('&');

const path = 'substreams/substreams.yaml';
let manifest = await readFile(path, 'utf8');
manifest = manifest.replace(/initialBlock: \d+/g, `initialBlock: ${startBlock}`);
manifest = manifest.replace(/^(\s+map_registry_events: ).*$/m, `$1${params}`).replace(/^(\s+map_horizon_events: ).*$/m, `$1${params}`);
const version = manifest.match(/^\s+version: (v[\d.]+)/m)?.[1] ?? 'v0.0.0';
await writeFile(path, manifest);
console.log(`Manifest written for registry ${addresses.registry} from block ${startBlock}.`);
if (manifestOnly) process.exit(0);

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: 'substreams', stdio: 'inherit' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') {
    throw new Error(`${command} is not installed. Install the Rust toolchain (rustup target add wasm32-unknown-unknown) and the substreams CLI, then rerun.`);
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
};
run('substreams', ['protogen', './substreams.yaml', '--exclude-paths=sf/substreams,google']);
run('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release']);
const spkg = `horizon-events-${version}.spkg`;
run('substreams', ['pack', './substreams.yaml', '-o', spkg]);
if (!existsSync(`substreams/${spkg}`)) throw new Error('pack produced no package');
const info = spawnSync('substreams', ['info', `./${spkg}`], { cwd: 'substreams', encoding: 'utf8' });
const hash = info.stdout?.match(/map_horizon_events[\s\S]*?Hash: ([0-9a-f]{40})/)?.[1] ?? null;
await writeFile('deployments/substreams.json', JSON.stringify({
  package: `substreams/${spkg}`, version, module: 'map_horizon_events', moduleHash: hash, network: 'sepolia',
  startBlock, params, packedAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`Packed ${spkg}; recorded in deployments/substreams.json.`);
