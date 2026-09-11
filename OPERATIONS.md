# Horizon foundation — setup and continuation

Implementation snapshot: September 9, 2026. **Phase 2 is implemented and verified live** on Sepolia and Graph Studio. [PHASE2.md](PHASE2.md) contains the deployed addresses, two-fill transaction, live indexing proof, API format, math, and remaining work. Hedera payments, World verification, React, and AI creation remain Phase 3 work.

Local Git history preserves the work in increments: `209555f` records the planning baseline, `196ca79` pins official contract sources and the settlement probe, and `d13a8c4` adds the tested TypeScript/admin/ORM/worker foundation. No remote repository or public deployment has been created.

## Local setup

Use Node **24.10.0** (`.nvmrc`) and npm **11.6.1**. The workspace also has Node 26 on its default PATH; select Node 24 before running npm. Do not upgrade Prisma independently of the AdminJS adapter.

```sh
cd horizon
source ~/.nvm/nvm.sh
nvm use
export PATH="$NVM_BIN:$PATH"
rehash
npm ci
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm run db:test:migrate
npm run dev
```

If `npm ci` reports `EBADENGINE` with Node 26, run the `source` and `nvm use` commands above in the **same terminal** before retrying. `.nvmrc` records the required version but does not automatically switch your shell. Node 24.10.0 is already installed on this machine. In an IDE, select `~/.nvm/versions/node/v24.10.0/bin/node` as the project's Node interpreter as well. Keep `engine-strict` enabled so installs use the tested runtime.

On this machine, `.zshrc` prepends `/opt/homebrew/bin` after loading nvm. Consequently, `nvm use` can announce Node 24 while `node` and `npm` still resolve to Homebrew's Node 26. If that happens, explicitly put the installed Node 24 directory first in the current terminal:

```sh
export PATH="$HOME/.nvm/versions/node/v24.10.0/bin:$PATH"
rehash
node --version  # must print v24.10.0
npm --version   # bundled version: 11.6.1
npm ci
```

This changes the current terminal only. The global shell configuration was not modified.

`setup:local` creates `.env` and a random admin password in `.local/admin-password.txt`, both private and ignored by Git. It refuses to overwrite an existing `.env`. In this workspace these files have already been created, so skip that step. The admin email is `admin@horizon.local`. Open [the local admin](http://127.0.0.1:3001/admin) and read the password from the local file; do not commit or paste it into a task.

**Docker is now the selected database runtime.** `npm run db:up` starts PostgreSQL 18.0 and waits for its health check. The initial-volume SQL automatically creates both `horizon` and `horizon_test`, owned by `horizon`. The container listens at `127.0.0.1:54329`; `.env` contains the corresponding application and test connection URLs. There is no need to run `createdb` during a fresh setup.

Useful database commands:

```sh
npm run db:up
npm run db:migrate
npm run db:test:migrate
docker compose ps
docker compose exec db psql -U horizon -d horizon
npm run db:down
```

The named Docker volume retains data when the container stops or is recreated. The fixed Compose password is for local development only. `docker compose exec` requires a running container; start it with `npm run db:up` first. The database username is `horizon`, not `user`.

The earlier native PostgreSQL cluster was stopped to free port 54329. Its files remain under `.local/pgdata`, and its application database was backed up to `.local/backups/native-horizon-before-docker.dump`. Docker starts with fresh application/test databases; the old diagnostic job and admin sessions are retained in the backup rather than imported. Do not start the native cluster on port 54329 while Docker is running.

Docker verification on September 8: `horizon-db-1` healthy on port 54329; both databases present; both migrations applied; TypeScript typecheck and all three admin/worker integration tests passed against the container.

## API, admin, and worker

The API exposes `/health/live`, `/health/ready`, and authenticated `/admin`. Readiness checks database connectivity only; it does not imply the worker, contracts, or sponsors are ready. AdminJS can inspect `CreationRequest` and `JobRun`. `CreationRequest` currently stores draft metadata only; no public creation or payment API exists yet.

The admin uses a salted scrypt password hash, login rate limiting, and PostgreSQL-backed sessions. Creation, editing, deletion, and bulk deletion are disabled in AdminJS; HTTP writes to its API are also blocked. Multipart uploads are rejected. Future retry/resolution actions must call deliberate service methods with authorization and audit records, rather than reopening generic database edits.

Start a separate worker and enqueue a diagnostic job:

```sh
npm run worker:dev
# In another terminal:
npm run job:probe
```

The `system.probe` job records one `JobRun` keyed by a stable probe ID. pg-boss persists jobs in its own PostgreSQL schema and retries failures with backoff. A stopped worker can process already queued work after restarting. This is the foundation for Celery-style service jobs; AI generation, payment reconciliation, and market deployment handlers are Phase 3 work. No background trading matcher was added.

Queue retries do not guarantee exactly-once external effects. Later payment and deployment handlers must reconcile durable request state and chain receipts before repeating an action, and coordinate persistence/enqueueing through a transaction or outbox.

Compiled processes are available with `npm run build`, then `npm start` and `npm run worker`. Deployment needs a persistent worker runtime, managed database credentials, HTTPS, and correctly scoped `TRUST_PROXY_HOPS`; no public hosting was configured in this phase.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run vendor:verify
npm run contracts:test
```

Database integration tests require a **dedicated localhost database named `horizon_test`**. They refuse other database names/hosts. Docker creates this database on first initialization, and the test command reads `TEST_DATABASE_URL` from `.env` (explicit environment variables still take precedence).

```sh
npm run db:up
npm run db:test:migrate
npm run test:integration
```

For a pre-existing Docker volume created before the initialization SQL was added, create the missing test database once with `docker compose exec db createdb -U horizon horizon_test`, then apply its migration. Initialization scripts do not rerun against an existing volume.

Verified locally: TypeScript typecheck/build; **8 unit tests**; **3 PostgreSQL integration tests** covering authenticated read-only admin, persisted jobs across worker startup/restart, duplicate effects, and retry; **39 Foundry tests** including three 256-case fuzz properties; and **1 isolated Anvil integration test** with 44 contract/TypeScript pricing comparisons, whole-route simulation and execution, exhaustion, and reorg checks. The Subgraph builds and is live; a real Graph-backed route executed two Sepolia fills, and Graph indexed the resulting collateral and exhausted curves. The 329 vendor file hashes remain unchanged. Remote CI is configured but has not run.

### Events, groups and Polymarket imports

Grouped events are service metadata over the existing markets, so they need a migration and two
optional settings, and nothing else:

```sh
npm run db:migrate          # applies 202609100002_market_events
npm run db:test:migrate     # the same, against horizon_test
```

The migration is additive and backward compatible. `CreationRequest.kind` defaults to `SINGLE` and
`eventId` stays `NULL`, so every request made before this change keeps its exact previous
behaviour, every existing market stays standalone with its existing URL, and standalone creation
and trading are unchanged.

Settings, all optional and defaulted in `.env.example`:

| Key | Default | Effect |
| --- | --- | --- |
| `IMPORTS_ENABLED` | `true` | Set to `false` to remove the import option and refuse the import routes with `imports_not_configured`. |
| `POLYMARKET_API_ORIGIN` | `https://gamma-api.polymarket.com` | The only origin the backend fetches source definitions from. Point it at a local stub in tests; it must be https otherwise. |
| `IMPORT_MAX_CHILDREN` | `24` | Upper bound on children per event, which also bounds what one creation request can cost. |

Verified locally on 2026-09-10 against the live Gamma API: `POST /api/creation/imports/preview`
with `https://polymarket.com/event/fed-decision-in-september-762` returned five YES/NO children
under one negative-risk (exclusive) event, priced at five creation charges, with no row written.

**Do not run the creation step against a configured deployer key unless you intend to create real
markets.** The creation job broadcasts to the registry as soon as a payment is settled, including
in `HEDERA_PAYMENT_MODE=simulated`, which simulates the *payment* only. To exercise the workflow
without deploying, run the API with `EVM_DEPLOYER_PRIVATE_KEY` genuinely unset — check with
`node --import tsx -e "import {loadConfig} from './src/config.js'; console.log(Boolean(loadConfig().creation?.privateKey))"`
rather than assuming a filtered `.env` dropped it.

### Public creation audit trail on HCS

Statements about a creation request — the approved draft, the settled x402 payment, the deployed
market — are written to an outbox in the same transaction as the workflow transition and published
to a Hedera Consensus Service topic by the worker. **Publication is never on the paid path**: an
unreachable topic delays the trail and cannot repeat a payment, repeat a deployment or fail a
creation.

Live since September 11, 2026 on topic `0.0.10473191` (Hedera testnet), whose submit key is the
audit signer's. Thirteen statements are published at sequence numbers 1–13; see
[docs/EVIDENCE.md](docs/EVIDENCE.md).

```sh
npm run db:migrate          # applies 202609110001_audit_events
npm run db:test:migrate     # the same, against horizon_test
npm run audit:topic -- --dry-run
npm run audit:topic         # creates the topic; put the printed id in .env
npm run audit:backfill -- --dry-run
npm run audit:verify -- --latest --record
```

The migration is additive: no existing table or column changes, and a request with no rows in
`AuditEvent` behaves exactly as it did before.

| Key | Default | Effect |
| --- | --- | --- |
| `HEDERA_AUDIT_ENABLED` | `true` | `false` records statements without publishing them. |
| `HEDERA_AUDIT_TOPIC_ID` | empty | The topic. Without it the outbox accumulates and nothing is published. |
| `HEDERA_AUDIT_ACCOUNT_ID`, `HEDERA_AUDIT_PRIVATE_KEY` | empty | The server-side audit signer. Its public key is the topic's submit key, so no other account can append. |
| `HEDERA_AUDIT_KEY_TYPE` | `ecdsa` | How a bare 32-byte hex key is read. A DER encoding names its own curve and is detected. |
| `HEDERA_MIRROR_NODE_URL` | testnet mirror | Used to reconcile unknown submissions and to verify published contents. |
| `HEDERA_AUDIT_PUBLISH_INTERVAL_MS` | `20000` | How often the worker sweeps the outbox. |

The API process needs only `HEDERA_AUDIT_TOPIC_ID` and `HEDERA_MIRROR_NODE_URL` to serve the
public trail (`/api/audit/events/:slug`, `/api/audit/markets/:address`, and the request view);
with a topic configured, `/api/config` reports `audit.reason` as `null` on that process. The
signer belongs to the worker alone.

Notes for whoever runs it next:

- **Delivery is at least once.** HCS orders and timestamps messages; it does not deduplicate
  application event ids. A submission whose outcome was unknown is reconciled against the mirror
  node first and only resubmitted if it cannot be found, so a duplicate is possible. Readers
  deduplicate by `eventId`. Do not describe this as exactly-once.
- **`UNCONFIRMED` is not a failure and not a success.** It means a submission was made and its
  outcome is unknown. It is never shown as published and never given a consensus timestamp.
- **Backfilled statements keep their event time in `occurredAt` only.** Their consensus timestamp
  is the time of publication. The API and the creation screen say so on the row; never present one
  as an original event-time timestamp.
- **The audit signer is separate from the x402 payer and the Sepolia deployer.** In this
  deployment the receiver account doubles as the signer; a production deployment should use a
  third account so receiving a creation fee and attesting to it are not the same key.
- The topic memo and the topic id are public. The signer's private key is not, and appears in no
  log, no API response and no published statement.

### Void a market that should not exist

A market created in error is voided by resolving it **INVALID** through the ordinary audited
workflow. INVALID is the disclosed result for a question Horizon will not settle: it pays 0.5 USDC
per outcome token, so a holder of a full YES/NO pair is made whole and a one-sided holder gets half
back. On a market holding no collateral it moves nothing.

```sh
npm run resolve:invalid -- --dry-run 0xMarket            # check only; never broadcasts
npm run resolve:invalid -- --reason "…" 0xMarket 0xMarket
```

`BinaryMarket.resolve` calls `close()`, which reverts with `MarketNotClosed` before the market's
close timestamp, so the script refuses to run early and prints exactly when each market becomes
resolvable instead of broadcasting a transaction that would revert. It is safe to run repeatedly:
an already resolved market is reported and skipped, and the submitter re-reads the on-chain result
before every broadcast. It needs `EVM_DEPLOYER_PRIVATE_KEY`, because only the disclosed resolver
key can resolve.

**Outstanding, created in error on 2026-09-10.** Four markets were created on Sepolia while the
group creation flow was being exercised locally: the run was intended to have no deployer key, but
the key was passed through by a mistaken `.env` filter, and `HEDERA_PAYMENT_MODE=simulated`
simulates the *payment* only — the creation job still broadcasts. They hold no collateral and are
to be resolved INVALID once they close at **2026-09-16T00:00:00Z**:

```sh
npm run resolve:invalid -- \
  --reason "Created in error while exercising the event creation flow; never intended for trading. Voided by the disclosed Horizon resolver." \
  0x1d65EcCCD938718ff3e6f508BF31CBAd845444F6 \
  0xfa138ecbbe0C4Ebe0c1245e0153dFEEF418aC701 \
  0xD8a3b11Ed177207C9ac349Ce904Ed3f92e6Ee012 \
  0x84d7f592933bB8b70eB5c03321A7014F010729d1
```

They are open and tradeable until then and cannot be closed early; the contract has no such path.

### Run the Phase 1 contract demo

From the Horizon root, with Foundry 1.2.3 installed:

```sh
npm run contracts:demo
npm run contracts:test
```

The demo prints a local EVM trace of Aqua authorization, a 0.60/0.40 match, fully backed minting, resolution, and redemption. It requires no Docker, API, private keys, or RPC. This is a contract demonstration; the trading UI is Phase 3 work. `npm run contracts:build` writes ABIs/artifacts to ignored `contracts/out/`. Phase 2 adds `npm run test:routes` for the local EVM/quote integration, `/api/markets` and `/api/quotes` on the API, and read-only `npm run demo:indexed` for live Graph evidence. [PHASE2.md](PHASE2.md) is the current handoff.

The macOS sandbox prevented PostgreSQL shared-memory initialization and caused Foundry's OS proxy lookup to crash; those commands succeeded outside the sandbox. These were environment limitations, not passing results inferred from failed tests.

## Per-market order budgets: deployed September 10, 2026

The order-budget rule is enforced on chain by `OrderBudget`, a ledger that `HorizonSwapVM` deploys
and owns, and `HorizonSwapVM` refuses to fill any order it has not admitted. That took a new router,
which is deployed and wired:

| Contract | Address |
| --- | --- |
| `HorizonSwapVM` | `0x2b7592171cc7cfaa21dd60b49c81d68cf584302d` |
| `OrderBudget` | `0x563D51c62260F484C5765712fd9716704cF266A2` |
| `RouteExecutor` | `0x657b5cf110bed745c5b3f33c77d61855abb4cfa9` |
| `MarketRegistry` | `0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1` — unchanged |
| Subgraph | Studio `0.3.2`, `https://api.studio.thegraph.com/query/1758973/horizon/0.3.2` |

`deploy:phase2` skips contracts already recorded in `deployments/sepolia.json`, so the router and
executor were cleared from it first and moved to `superseded`. The registry was deliberately left in
place: clearing it too would have created a second registry and orphaned every existing market.
`startBlock` is likewise unchanged, so the Subgraph still indexes markets created before the change.

`.env` was updated in place with `HORIZON_ROUTER_ADDRESS`, `HORIZON_EXECUTOR_ADDRESS` and
`GRAPH_QUERY_URL`. **Restart the API and worker** so they pick them up.

Verified after deployment, not merely broadcast: the router names the registry and Aqua, the
executor names the router, and `router.budget()` and `budget.app()` name each other. A live check
then admitted an order committing exactly the wallet's whole approved USDC budget, had a further
one-base-unit order refused on chain with `MarketBudgetExceeded` (`0x90ac6f09`), confirmed that the
shipped-but-unadmitted order committed nothing, and docked both to leave the wallet as it was found.
Transactions: `deployments/order-budget-evidence.json`.

The indexer then showed the same two orders as `admitted: true` and `admitted: false`, which is the
direct-Aqua publication case end to end: Aqua accepted both, the router accepted one, and only the
admitted one is served as depth.

**Indexer lag to watch.** `0.3.1` had backfilled all eleven markets and was ~130 blocks behind the
head when this was written, advancing slowly for the reason above. `QuoteService` rejects a snapshot
more than 64 blocks behind with `stale_graph`, so market orders will refuse to price until it closes
the gap. Publication, cancellation, redemption and the budget endpoint do not read the indexer at
all and are unaffected.

To repeat the whole sequence elsewhere:

```sh
npm run contracts:test          # 54 tests, including test/OrderBudget.t.sol
npm run test:routes             # both Anvil suites, including the enforcement boundary
npm run db:migrate              # adds CurveProjection.admitted
npm run deploy:phase2           # clear router/executor from deployments/sepolia.json first
npm run subgraph:prepare && npm run subgraph:codegen && npm run subgraph:deploy
```

The API process needs only `HEDERA_AUDIT_TOPIC_ID` and `HEDERA_MIRROR_NODE_URL` to serve the
public trail (`/api/audit/events/:slug`, `/api/audit/markets/:address`, and the request view);
with a topic configured, `/api/config` reports `audit.reason` as `null` on that process. The
signer belongs to the worker alone.

Notes for whoever runs it next:

- `HorizonSwapVM` is **23,514 bytes**, 1,062 under the EIP-170 limit. Check
  `forge build --root contracts --sizes` before adding to it; the deploy script refuses an
  oversized artifact rather than discovering it on chain.
- `GRAPH_SUBGRAPH_VERSION` sets the Studio version label and defaults to `0.3.0`. Studio will not
  reuse a label, and a schema change needs a full re-index, so bump it every time.
- **Archive superseded versions in Studio.** `0.3.0` was deployed with every data source starting at
  the registry's block, which made the Aqua source rescan ~12,600 blocks calling a router that did
  not exist yet for every `Shipped` event; it crawled and was replaced by `0.3.1`, which starts the
  router-facing sources at `routerBlock`. Studio keeps indexing the superseded version and the two
  compete for a free-tier slot, so `0.3.1` is currently syncing slowly. Archiving `0.3.0` in the
  Studio web UI frees that capacity — there is no CLI or API for it.
- **`0.3.2` replaces `0.3.1`, which died on its first Aqua `Docked` event.** The manifest had mapped
  `Docked → handleDock` since the Graph mappings landed, but the handler itself was only added to
  `subgraph/src/mapping.ts` afterwards, so the `0.3.1` WASM never exported it. Graph Node accepts
  such a manifest and fails permanently at the first matching event (`function handleDock not found`);
  `graph build` does not catch it. After touching the manifest generator, grep the built WASM for
  every handler it names before deploying.
- **Studio query endpoints allow 3,000 requests per day per version URL**, and `GRAPH_API_KEY` is
  ignored there — it only authenticates the decentralized gateway. Each mirror sync is two queries
  (markets page, strategies page), so `MARKET_SYNC_INTERVAL_MS=15000` spent ~11,500 a day and the
  endpoint answered `429` with `graph_unavailable` on every page until the window reset. Production
  runs `MARKET_SYNC_INTERVAL_MS=120000` with `MARKET_SYNC_MAX_STALENESS_MS=360000` (~1,440 sync
  queries a day; quotes are one query each). A failing sync makes this worse, not better: once the
  mirror is stale every `/api/markets` read goes to The Graph directly. The way out of the cap is to
  publish the subgraph to the network from Studio and point `GRAPH_QUERY_URL` at
  `https://gateway.thegraph.com/api/subgraphs/id/<id>`, which is what the Bearer key is for.
- Curves published to the previous router stay on the previous router. They are not migrated, and
  the Subgraph indexes only orders admitted to the new one — expect the market pages to show no
  resting liquidity until makers republish.
- Publication is now two transactions for the maker: `Aqua.ship`, then `HorizonSwapVM.admitCurve`.
  The frontend runs both and, if the second fails, resumes at the admission rather than shipping a
  second allocation. An order stuck between the two appears in the Portfolio as **Not published**
  and can be cancelled to recover the allocation.
- Aqua allowances are per spender, not per router, so a maker's existing USDC approval to Aqua
  carries over to the new router unchanged.

## Sponsor readiness

```sh
npm run doctor
```

This read-only command reports `ok`, `pending`, or `failed` without printing secrets or credential-bearing URLs. Exit code **0** means all recorded checks pass, **2** means work/access remains pending, and **1** means a configured check failed. It never sends a payment, deploys a contract, or claims account verification from merely present environment variables.

On September 8 the public Blocky402 `/supported` endpoint advertised `exact`, `hedera:testnet`, x402 version 2. This establishes advertised capability only. Remaining work:

- Sepolia contracts are deployed and wired correctly. Official AquaRouter has an exact Sourcify runtime match and core sources matching our pins. A real two-fill route, fully backed minting, shared-wallet depletion, and stale-route rejection are recorded under `deployments/`.
- Hedera receiver/payer credentials and WalletConnect configuration are populated; prove funding and real browser/agent paid requests through Blocky402.
- Graph Studio deployment and live queries are verified. `GRAPH_QUERY_URL` and the three `HORIZON_*_ADDRESS` values are now populated locally. A live query shows the completed route, both fills, correct collateral, and inactive exhausted strategies. Graph-grounded AI remains Phase 3 work.
- World app/RP/action configuration is populated. `WORLD_SELFIE_ACCESS` remains `unknown`; Selfie Check/Sandbox access and a real credential verification still need proof.

Use `.env.example` for configuration names. Do not send private keys in task messages. Public deployed addresses, endpoints without secrets, and transaction hashes can be added to documentation after verification. All four sponsors remain required.

## Dependency findings before public release

Versions are exact in `package.json` and `package-lock.json`: Express 4.22.2, AdminJS 7.8.17, its Express adapter 6.1.1 and Prisma adapter 5.0.4, Prisma/client 6.19.3, pg-boss 10.4.2. The Prisma adapter declares support for Prisma 5/6 and AdminJS 7. The selected combination is now tested locally.

The install audit on September 8 reported **46 findings: 42 moderate and 4 high, no critical**. The four high package entries trace to two causes: TinyMCE bundled transitively by AdminJS's design system, and deepmerge-ts in Prisma's development configuration tooling. Read-only Horizon resources do not use rich-text editing, and the CLI does not process uploaded Prisma configs; this does not erase the advisories. A non-breaking `npm audit fix --dry-run` proposed no dependency changes. Do not run `--force` and silently downgrade the tested stack. Resolve or explicitly assess these dependencies before exposing the admin publicly or enabling rich-text inputs. The API currently binds to loopback by default.

Relevant advisories: [TinyMCE media injection](https://github.com/advisories/GHSA-vg35-5wq7-3x7w), [deepmerge-ts recursive graphs](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Re-run the audit before deployment; counts are a dated snapshot.

Phase 2 pins `viem@2.56.3`, `@graphprotocol/graph-cli@0.98.1`, and `@graphprotocol/graph-ts@0.38.2`. With Graph's **development-only CLI**, the local audit reports 61 total findings (46 moderate, 14 high, 1 critical). The critical finding is the CLI's `decompress` archive extraction dependency, used by its local-node download helper; Horizon uses codegen/build/Studio deploy and does not call that helper. Keep Graph CLI tooling out of production installs (`npm ci --omit=dev`) and do not use its vulnerable archive downloader. Its older suggested CLI downgrade also brings an older dependency tree, so it was not applied blindly. This scope assessment does not remove the advisory; dependency remediation remains pre-public-release work. No public API/admin hosting has been performed.

## Continue from here

Read `README.md`, `PROJECT_BRIEF.md`, `PHASE2.md`, and `contracts/README.md`, then continue with **Phase 3: creation service and React application**. The deployed registry/router/executor and Subgraph are available; do not redeploy them merely to restart context. Keep zero trading fees, manual resale, USDC-only sharing, market-bound outcomes, and all four required sponsors. Credentials are local; do not reopen the TypeScript stack decision or ask for values already present. World Selfie Check access remains unknown, and both browser/agent Hedera payment paths still need real proof.
