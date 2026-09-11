/**
 * Reads one request's published audit trail back from the Hedera mirror node and compares it,
 * byte for byte, with what this service holds.
 *
 *   npm run audit:verify -- --request <uuid>
 *   npm run audit:verify -- --latest              # the most recently created request with a trail
 *   npm run audit:verify -- --latest --record     # also write deployments/audit-evidence.json
 *
 * Read-only against Hedera: it publishes nothing and spends nothing. `--record` writes a public
 * evidence file containing topic, transaction, consensus timestamp, sequence number and the
 * published statement — all of which are already public on the topic.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { databaseUrl, loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { AuditService } from '../src/audit/service.js';
import { MirrorNodeReader, UnconfiguredAuditPublisher } from '../src/audit/hcs.js';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const requestId = arg('--request');
const latest = process.argv.includes('--latest');
const record = process.argv.includes('--record');
if (!requestId && !latest) throw new Error('Usage: npm run audit:verify -- --request <uuid> | --latest [--record]');

const config = loadConfig();
const db = createDatabase(databaseUrl());
// Verification never submits, so the publisher is deliberately the unconfigured one: this command
// cannot publish a statement even if the audit signer happens to be configured in this shell.
const audit = new AuditService({
  db, config: config.audit, publisher: new UnconfiguredAuditPublisher(),
  mirror: new MirrorNodeReader(config.audit.mirrorNodeUrl),
});

try {
  let target = requestId;
  if (!target) {
    const newest = await db.auditEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { requestId: true } });
    if (!newest) throw new Error('No audit statements have been recorded yet.');
    target = newest.requestId;
  }
  const events = await audit.trail(target);
  if (events.length === 0) throw new Error(`Request ${target} has no audit statements.`);
  const results = await audit.verify(events);
  console.log(`Request ${target}`);
  console.log(`Topic    ${config.audit.topicId || '(not configured)'} on Hedera ${config.audit.network}`);
  console.log(`Mirror   ${config.audit.mirrorNodeUrl}\n`);
  let verified = 0;
  for (const event of events) {
    const result = results.find(entry => entry.eventId === event.eventId)!;
    const state = event.status === 'PUBLISHED' ? (result.matches ? 'verified' : `MISMATCH (${result.reason})`) : `${event.status.toLowerCase()} (${result.reason ?? 'not published'})`;
    if (result.matches) verified++;
    console.log(`#${event.sequence} ${event.type}`);
    console.log(`   eventId    ${event.eventId}`);
    console.log(`   status     ${state}${event.backfilled ? ' · backfilled: the consensus timestamp is the publication time, not the event time' : ''}`);
    console.log(`   occurredAt ${event.occurredAt.toISOString()}`);
    if (event.consensusAt) console.log(`   consensus  ${result.consensusTimestamp ?? ''} (${event.consensusAt.toISOString()})`);
    if (event.transactionId) console.log(`   hedera tx  ${event.transactionId}`);
    if (result.url) console.log(`   mirror     ${result.url}`);
    if (event.failureCode) console.log(`   note       ${event.failureCode}`);
    console.log('');
  }
  console.log(`${verified} of ${events.length} statements read back from the mirror node and matched byte for byte.`);
  console.log('This proves the topic holds exactly what Horizon says it published. It does not verify the Hedera payment,');
  console.log('the Sepolia deployment or any market outcome; each of those is checked at its own source.');

  if (record) {
    await mkdir('deployments', { recursive: true });
    const file = 'deployments/audit-evidence.json';
    await writeFile(file, `${JSON.stringify({
      network: config.audit.network, topicId: config.audit.topicId, mirrorNodeUrl: config.audit.mirrorNodeUrl,
      explorerTopicUrl: `${config.audit.explorerBase.replace(/\/$/, '')}/topic/${config.audit.topicId}`,
      requestId: target, verifiedAt: new Date().toISOString(),
      delivery: 'at_least_once',
      note: 'HCS records Horizon\'s own statements and their ordering. It does not verify the referenced Hedera payment, the Sepolia deployment or any market outcome.',
      events: events.map(event => {
        const result = results.find(entry => entry.eventId === event.eventId)!;
        return {
          sequence: event.sequence, type: event.type, eventId: event.eventId, status: event.status,
          backfilled: event.backfilled, occurredAt: event.occurredAt.toISOString(),
          transactionId: event.transactionId, consensusTimestamp: result.consensusTimestamp ?? null,
          sequenceNumber: event.sequenceNumber, mirrorUrl: result.url ?? null,
          mirrorMatches: result.matches, payload: event.payload,
        };
      }),
    }, null, 2)}\n`);
    console.log(`\nWrote ${file}.`);
  }
  process.exit(verified === events.length ? 0 : 2);
} finally {
  await db.$disconnect();
}
