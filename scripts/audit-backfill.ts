/**
 * Records audit statements for creation requests that completed before the trail existed.
 *
 *   npm run audit:backfill -- --dry-run              # report what would be recorded
 *   npm run audit:backfill -- --request <uuid>       # one request
 *   npm run audit:backfill                           # every eligible request
 *
 * This writes outbox rows only; the worker publishes them like any other. Every row it writes is
 * marked `backfilled`, and the published statement carries `"backfilled": true`, because a
 * backfilled statement's consensus timestamp is the time Horizon published it and **not** the
 * time the event happened. `occurredAt` carries the event time this service actually recorded.
 * Nothing here can be presented as an original, event-time consensus timestamp.
 */
import { databaseUrl, loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { AuditService } from '../src/audit/service.js';
import { MirrorNodeReader, UnconfiguredAuditPublisher } from '../src/audit/hcs.js';
import { draftApproved, marketCreated, paymentSettled, type AuditRecord } from '../src/audit/events.js';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const dryRun = process.argv.includes('--dry-run');
const only = arg('--request');
const CHAIN_ID = 11155111;

const config = loadConfig();
const db = createDatabase(databaseUrl());
// Backfill records; it never publishes. The worker is the only thing that submits to the topic.
const audit = new AuditService({
  db, config: config.audit, publisher: new UnconfiguredAuditPublisher(),
  mirror: new MirrorNodeReader(config.audit.mirrorNodeUrl),
});

try {
  const requests = await db.creationRequest.findMany({
    where: { ...(only ? { id: only } : {}), approvedHash: { not: null } },
    include: { payment: true, children: { orderBy: { position: 'asc' } }, auditEvents: true },
    orderBy: { createdAt: 'asc' },
  });
  let recorded = 0;
  for (const request of requests) {
    const known = new Set(request.auditEvents.map(event => event.eventId));
    const draftHash = request.approvedHash!;
    const pending: AuditRecord[] = [];
    if (request.approvedAt) pending.push(draftApproved({ requestId: request.id, draftHash, occurredAt: request.approvedAt, backfilled: true }));
    const payment = request.payment;
    if (payment?.status === 'SETTLED' && payment.transactionRef) {
      pending.push(paymentSettled({
        requestId: request.id, draftHash, occurredAt: payment.settledAt ?? payment.updatedAt, backfilled: true,
        network: payment.network, asset: payment.asset, amountUnits: payment.amountUnits, transactionRef: payment.transactionRef,
      }));
      // A market statement references the settled payment, so it exists only where one does.
      const deployed = request.kind === 'GROUP'
        ? request.children.filter(child => child.status === 'CREATED' && child.marketAddress)
          .map(child => ({ address: child.marketAddress!, transactionHash: child.creationTxHash, occurredAt: child.updatedAt, position: child.position }))
        : request.marketAddress
          ? [{ address: request.marketAddress, transactionHash: request.creationTxHash, occurredAt: request.updatedAt, position: undefined }]
          : [];
      for (const market of deployed) {
        pending.push(marketCreated({
          requestId: request.id, draftHash, occurredAt: market.occurredAt, backfilled: true,
          transactionRef: payment.transactionRef, chainId: CHAIN_ID, address: market.address,
          transactionHash: market.transactionHash, position: market.position,
        }));
      }
    }
    const missing = pending.filter(entry => !known.has(entry.eventId));
    if (missing.length === 0) continue;
    console.log(`${request.id} · ${request.status} · ${missing.map(entry => `#${entry.sequence} ${entry.type}`).join(', ')}`);
    if (dryRun) { recorded += missing.length; continue; }
    await db.$transaction(async tx => { for (const entry of missing) await audit.record(tx, entry); });
    recorded += missing.length;
  }
  console.log(`\n${dryRun ? 'Would record' : 'Recorded'} ${recorded} backfilled statement${recorded === 1 ? '' : 's'} across ${requests.length} request${requests.length === 1 ? '' : 's'}.`);
  if (!dryRun && recorded > 0) {
    console.log('Every one is marked backfilled: once published, its consensus timestamp is the time of publication, not the time of the event.');
    console.log('Run the worker to publish them, then npm run audit:verify -- --request <uuid>.');
  }
} finally {
  await db.$disconnect();
}
