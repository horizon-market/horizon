import { mkdir, readFile, writeFile } from 'node:fs/promises';

const names = ['MarketRegistry', 'BinaryMarket', 'HorizonSwapVM', 'RouteExecutor', 'Aqua'];
await mkdir('subgraph/abis', { recursive: true });
for (const name of names) {
  const artifact = JSON.parse(await readFile(`contracts/out/${name}.sol/${name}.json`, 'utf8')) as { abi: unknown };
  await writeFile(`subgraph/abis/${name}.json`, JSON.stringify(artifact.abi, null, 2) + '\n');
}
const zero = '0x0000000000000000000000000000000000000001';
let deployment: Record<string, string> = {};
try { deployment = JSON.parse(await readFile('deployments/sepolia.json', 'utf8')); } catch {}
const start = deployment.startBlock ?? '0';
const router = deployment.router ?? process.env.HORIZON_ROUTER_ADDRESS ?? zero;
// The registry must be scanned from the beginning so markets created before the current router are
// still indexed. Everything that concerns the router itself starts at the block it was deployed:
// no Aqua `Shipped` event can name a router that did not exist, and scanning those blocks anyway
// costs one contract call per shipped strategy to decide nothing. `routerBlock` is recorded by the
// deployment script; without it the sweep falls back to the registry's own start block.
const routerStart = deployment.routerBlock ?? start;
const sources = [
  { name: 'Registry', abi: 'MarketRegistry', start, address: deployment.registry ?? zero, event: 'MarketCreated(indexed bytes32,indexed address,indexed address,address,address,uint40,string,string,string)', handler: 'handleMarket' },
  { name: 'Aqua', abi: 'Aqua', start: routerStart, address: deployment.aqua ?? process.env.AQUA_ADDRESS ?? zero, event: 'Shipped(address,address,bytes32,bytes)', handler: 'handleShip', extra: '        - event: Docked(address,address,bytes32)\n          handler: handleDock\n' },
  { name: 'Router', abi: 'HorizonSwapVM', start: routerStart, address: router, event: 'CurveFilled(indexed bytes32,indexed address,indexed address,uint256,uint256,uint256)', handler: 'handleFill',
    // Admission is what makes a shipped order executable, so discovery follows it and not `Shipped`.
    extra: '        - event: StrategyAdmitted(indexed bytes32,indexed address,indexed address,address,uint256,uint256,uint256)\n          handler: handleAdmit\n' },
  { name: 'Executor', abi: 'RouteExecutor', start: routerStart, address: deployment.executor ?? zero, event: 'RouteExecuted(indexed address,indexed address,indexed address,bool,bool,uint256,uint256,uint256)', handler: 'handleRoute' },
];
const abis = names.map(n => `        - name: ${n}\n          file: ./abis/${n}.json`).join('\n');
const mapping = `      kind: ethereum/events\n      apiVersion: 0.0.9\n      language: wasm/assemblyscript\n      entities: [Market, Strategy, Fill, Route]\n      abis:\n${abis}\n`;
let yaml = `specVersion: 1.3.0\nschema:\n  file: ./schema.graphql\ndataSources:\n`;
for (const s of sources) yaml += `  - kind: ethereum\n    name: ${s.name}\n    network: sepolia\n    context:\n      router:\n        type: String\n        data: '${router}'\n    source:\n      address: '${s.address}'\n      abi: ${s.abi}\n      startBlock: ${s.start}\n    mapping:\n${mapping}      eventHandlers:\n        - event: ${s.event}\n          handler: ${s.handler}\n${s.extra ?? ''}      file: ./src/mapping.ts\n`;
yaml += `templates:\n  - kind: ethereum\n    name: BinaryMarket\n    network: sepolia\n    source:\n      abi: BinaryMarket\n    mapping:\n${mapping}      eventHandlers:\n        - event: CollateralChanged(uint256)\n          handler: handleCollateral\n        - event: MarketResolved(uint8,indexed address,string)\n          handler: handleResolution\n      file: ./src/mapping.ts\n`;
await writeFile('subgraph/subgraph.yaml', yaml);
console.log(`Prepared Subgraph ${deployment.router ? 'for deployed contracts' : 'with build-only placeholder addresses'}.`);
