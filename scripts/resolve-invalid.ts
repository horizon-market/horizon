import type { Address } from 'viem';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { buildServices } from '../src/services.js';
import { WorkflowError } from '../src/creation/service.js';

/**
 * Resolves named markets to INVALID through the ordinary, audited resolution workflow.
 *
 * This exists for markets that should never have been created. INVALID is the disclosed result for
 * a question Horizon will not settle: it pays 0.5 USDC per outcome token, so a holder of a full
 * YES/NO pair is made whole and a one-sided holder gets half back. That is the honest outcome for a
 * void market, and on a market holding no collateral it moves nothing at all.
 *
 * Nothing here is a shortcut around the contract. `BinaryMarket.resolve` calls `close()`, which
 * reverts with `MarketNotClosed` before the market's close timestamp, so running this early is
 * refused with the exact time it becomes possible rather than broadcasting a transaction that
 * would revert. It is safe to run repeatedly: a market that is already resolved is reported and
 * skipped, and the submitter re-reads the on-chain result before every broadcast.
 *
 *   npm run resolve:invalid -- --reason "…" 0xMarket 0xMarket …
 *   npm run resolve:invalid -- --dry-run 0xMarket        # check only; never broadcasts
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reasonAt = args.indexOf('--reason');
const reason = reasonAt >= 0 ? args[reasonAt + 1] : undefined;
const markets = args.filter((value, index) =>
  ADDRESS.test(value) && index !== reasonAt + 1) as Address[];

if (markets.length === 0) {
  console.error('Usage: npm run resolve:invalid -- [--dry-run] [--reason "…"] 0xMarket [0xMarket …]');
  process.exit(2);
}
const evidence = (reason ?? 'Market created in error and never intended for trading; voided by the disclosed Horizon resolver.').trim();
if (evidence.length < 10 || evidence.length > 2000) {
  console.error('The evidence reference must be between 10 and 2000 characters.');
  process.exit(2);
}

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
// `enqueueResolution` normally hands the job to the worker. Here the submission is run inline and
// reported, so an operator running this sees the outcome instead of a queued id.
const services = buildServices(config, db, { enqueueResolution: async () => undefined });
const actor = `script:resolve-invalid:${config.ADMIN_EMAIL}`;
const now = Math.floor(Date.now() / 1000);

let failed = 0;
try {
  for (const market of markets) {
    const label = market;
    try {
      const detail = await services.markets!.detail(market);
      const state = detail.market;
      if (state.result !== 0) {
        console.log(`${label} already resolved (${['UNRESOLVED', 'YES', 'NO', 'INVALID'][state.result]}); nothing to do.`);
        continue;
      }
      if (state.closeAt > now) {
        const hours = ((state.closeAt - now) / 3600).toFixed(1);
        console.log(`${label} closes ${new Date(state.closeAt * 1000).toISOString()} (in ${hours}h). The contract refuses resolution before then; run this again after it closes.`);
        failed++;
        continue;
      }
      if (dryRun) {
        console.log(`${label} is closed and unresolved; a real run would resolve it INVALID.`);
        continue;
      }
      // The ordinary workflow: it records the intent with an audit entry, checks the market is
      // closed and unresolved, and enforces the exclusive-group rule. INVALID is never blocked by
      // that rule, because a void event has to be settleable across a whole group.
      const record = await services.admin.requestResolution(actor, market, 'INVALID', evidence);
      const submitted = await services.admin.runResolution(record.id);
      console.log(`${label} resolved INVALID · ${submitted.status}${submitted.txHash ? ` · ${submitted.txHash}` : ' (already resolved on chain)'}`);
    } catch (error) {
      failed++;
      const code = error instanceof WorkflowError ? error.code : error instanceof Error ? error.message : String(error);
      console.error(`${label} could not be resolved: ${code}`);
    }
  }
} finally {
  await db.$disconnect();
}
if (failed > 0) {
  console.error(`\n${failed} of ${markets.length} market(s) were not resolved. Nothing partial was left half-done: each market is resolved or untouched.`);
  process.exitCode = 1;
}
