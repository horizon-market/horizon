import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { creationId } from '../src/creation/onchain.js';

/**
 * Fills `creationId` on requests and children that predate the column.
 *
 * The registry key is keccak256 over the request id (and, for a child, its position); the stream
 * consumer uses the stored key to find the request a MarketCreated event belongs to. Until this has
 * run, a legacy row is still matched by its marketAddress, so the backfill is a cleanup rather than a
 * prerequisite. Safe to run repeatedly: rows that already carry the key are skipped.
 *
 *   npm run creation:backfill-ids
 */
const db = createDatabase(databaseUrl());
await db.$connect();
try {
  const requests = await db.creationRequest.findMany({ where: { creationId: null, kind: 'SINGLE' }, select: { id: true } });
  for (const request of requests) {
    await db.creationRequest.update({ where: { id: request.id }, data: { creationId: creationId(request.id) } });
  }
  const children = await db.creationChild.findMany({ where: { creationId: null }, select: { id: true, requestId: true, position: true } });
  for (const child of children) {
    await db.creationChild.update({ where: { id: child.id }, data: { creationId: creationId(child.requestId, child.position) } });
  }
  console.log(`Backfilled creation ids: ${requests.length} requests, ${children.length} children`);
} finally {
  await db.$disconnect();
}
