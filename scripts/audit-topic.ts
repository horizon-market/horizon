/**
 * Creates the Hedera Consensus Service topic that carries Horizon's public audit trail.
 *
 *   npm run audit:topic -- --dry-run          # report what would be created; sends nothing
 *   npm run audit:topic                       # create the topic and print its id
 *
 * The topic is restricted to the configured audit signer: its public key is the submit key, so
 * no other account can append a statement to the trail, and the same key is the admin key so the
 * topic can be updated or retired later. It spends a small amount of testnet HBAR from
 * `HEDERA_AUDIT_ACCOUNT_ID`, and is the only deliberate write in the audit integration.
 *
 * Nothing here prints, stores or returns a private key. The topic id it prints is public and is
 * meant to be written into `.env` as `HEDERA_AUDIT_TOPIC_ID`.
 */
import { Client, TopicCreateTransaction } from '@hiero-ledger/sdk';
import { loadConfig } from '../src/config.js';
import { parseAuditKey } from '../src/audit/hcs.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const memoArgument = process.argv.indexOf('--memo');
const config = loadConfig().audit;

if (!config.operatorId || !config.operatorKey) {
  throw new Error('Set HEDERA_AUDIT_ACCOUNT_ID and HEDERA_AUDIT_PRIVATE_KEY (a dedicated server-side audit signer) before creating a topic.');
}
if (config.topicId && !force) {
  throw new Error(`HEDERA_AUDIT_TOPIC_ID is already set to ${config.topicId}. Creating a second topic would split the trail; pass --force if that is intended.`);
}
if (config.network === 'mainnet' && !force) {
  throw new Error('Refusing to create a mainnet topic without --force. This release is a testnet preview.');
}

const memo = (memoArgument >= 0 ? process.argv[memoArgument + 1] : undefined)
  // A topic memo is 100 bytes. It names what the trail is and, deliberately, whose statements
  // it carries — the same disclosure the API and the UI make.
  ?? 'Horizon market-creation audit trail. Schema horizon.audit.v1. Horizon\'s own statements.';
if (Buffer.byteLength(memo, 'utf8') > 100) throw new Error('A topic memo is at most 100 bytes.');

const key = parseAuditKey(config.operatorKey, config.keyType);
console.log(`Network:      Hedera ${config.network}`);
console.log(`Audit signer: ${config.operatorId} (${config.keyType} key, ${key.publicKey.toStringDer().length / 2} byte DER public key)`);
console.log(`Submit key:   ${key.publicKey.toStringDer()}`);
console.log(`Admin key:    the same audit signer`);
console.log(`Memo:         ${memo}`);

if (dryRun) {
  console.log('\nDry run: no topic was created and no HBAR was spent.');
  process.exit(0);
}

const client = Client.forName(config.network);
client.setOperator(config.operatorId, key);
client.setRequestTimeout(config.requestTimeoutMs);
try {
  const response = await new TopicCreateTransaction()
    // Only the audit signer may append. Without a submit key the topic would accept a statement
    // from any account, and the trail would attest nothing about who made it.
    .setSubmitKey(key.publicKey)
    .setAdminKey(key.publicKey)
    .setTopicMemo(memo)
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (!receipt.topicId) throw new Error('The network accepted the transaction but returned no topic id.');
  const topicId = receipt.topicId.toString();
  console.log(`\nCreated topic ${topicId}`);
  console.log(`Transaction:  ${response.transactionId.toString()}`);
  console.log(`Explorer:     ${config.explorerBase.replace(/\/$/, '')}/topic/${topicId}`);
  console.log(`Mirror node:  ${new URL(`/api/v1/topics/${topicId}`, config.mirrorNodeUrl).toString()}`);
  console.log(`\nAdd to .env (git-ignored):\n  HEDERA_AUDIT_TOPIC_ID=${topicId}`);
  console.log('Then restart the API and the worker so they pick it up.');
} finally {
  client.close();
}
