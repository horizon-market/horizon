import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const lock = JSON.parse(await readFile('contracts/vendor-lock.json', 'utf8')) as { files: Record<string, string> };
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))).flat();
}
const paths = (await walk('contracts/vendor')).sort();
if (JSON.stringify(paths) !== JSON.stringify(Object.keys(lock.files).sort())) throw new Error('Vendored file set changed');
for (const path of paths) {
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== lock.files[path]) throw new Error(`Vendored source changed: ${path}`);
}
console.log(`Verified ${paths.length} vendored files against recorded source hashes.`);
