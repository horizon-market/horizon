# Horizon foundation — setup and continuation

Implementation snapshot: September 9, 2026. The Phase 0 local foundation and Phase 1 contract exit work. Credentials have since been populated locally, but public contract deployment and live sponsor flows remain pending.

Local Git history preserves the work in increments: `209555f` records the planning baseline, `196ca79` pins official contract sources and the settlement probe, and `d13a8c4` adds the tested TypeScript/admin/ORM/worker foundation. No remote repository or public deployment has been created.

## Local setup

Use Node **24.10.0** (`.nvmrc`) and npm **11.6.1**. The workspace also has Node 26 on its default PATH; select Node 24 before running npm. Do not upgrade Prisma independently of the AdminJS adapter.

```sh
cd /Users/xana/work/ethglobal2026/horizon
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

Verified locally: TypeScript typecheck/build; two unit tests; three actual PostgreSQL integration tests covering authenticated read-only admin, persisted jobs across worker startup/restart, duplicate effects, and retry. Phase 1 adds market lifecycle and fully backed complementary execution: 33 Foundry tests pass, including two fuzz properties with 256 cases each. The 329 vendor file hashes remain unchanged. Prisma migration diff against the live test schema reported no difference. The browser login page rendered successfully. The GitHub workflow runs the local checks after push, but remote CI has not run yet.

### Run the Phase 1 contract demo

From the Horizon root, with Foundry 1.2.3 installed:

```sh
npm run contracts:demo
npm run contracts:test
```

The demo prints a local EVM trace of Aqua authorization, a 0.60/0.40 match, fully backed minting, resolution, and redemption. It requires no Docker, API, private keys, or RPC. This is a contract demonstration; the trading UI is Phase 3 work. `npm run contracts:build` writes ABIs/artifacts to ignored `contracts/out/`. See `contracts/README.md` for the Phase 2 integration handoff.

The macOS sandbox prevented PostgreSQL shared-memory initialization and caused Foundry's OS proxy lookup to crash; those commands succeeded outside the sandbox. These were environment limitations, not passing results inferred from failed tests.

## Sponsor readiness

```sh
npm run doctor
```

This read-only command reports `ok`, `pending`, or `failed` without printing secrets or credential-bearing URLs. Exit code **0** means all recorded checks pass, **2** means work/access remains pending, and **1** means a configured check failed. It never sends a payment, deploys a contract, or claims account verification from merely present environment variables.

On September 8 the public Blocky402 `/supported` endpoint advertised `exact`, `hedera:testnet`, x402 version 2. This establishes advertised capability only. Remaining work:

- The latest doctor checks confirmed the Sepolia chain ID, code at the configured Aqua/USDC addresses, six-decimal USDC, and positive deployer ETH/test USDC balances. Official Aqua bytecode identity and Horizon deployment still need verification.
- Hedera receiver/payer credentials and WalletConnect configuration are populated; prove funding and real browser/agent paid requests through Blocky402.
- `GRAPH_SUBGRAPH_SLUG`, `GRAPH_DEPLOY_KEY`, and `GRAPH_API_KEY` are populated locally. Verify Studio access through deployment, then set `GRAPH_QUERY_URL` to the resulting endpoint. Horizon now emits the relevant local events.
- World app/RP/action configuration is populated. `WORLD_SELFIE_ACCESS` remains `unknown`; Selfie Check/Sandbox access and a real credential verification still need proof.

Use `.env.example` for configuration names. Do not send private keys in task messages. Public deployed addresses, endpoints without secrets, and transaction hashes can be added to documentation after verification. All four sponsors remain required.

## Dependency findings before public release

Versions are exact in `package.json` and `package-lock.json`: Express 4.22.2, AdminJS 7.8.17, its Express adapter 6.1.1 and Prisma adapter 5.0.4, Prisma/client 6.19.3, pg-boss 10.4.2. The Prisma adapter declares support for Prisma 5/6 and AdminJS 7. The selected combination is now tested locally.

The install audit on September 8 reported **46 findings: 42 moderate and 4 high, no critical**. The four high package entries trace to two causes: TinyMCE bundled transitively by AdminJS's design system, and deepmerge-ts in Prisma's development configuration tooling. Read-only Horizon resources do not use rich-text editing, and the CLI does not process uploaded Prisma configs; this does not erase the advisories. A non-breaking `npm audit fix --dry-run` proposed no dependency changes. Do not run `--force` and silently downgrade the tested stack. Resolve or explicitly assess these dependencies before exposing the admin publicly or enabling rich-text inputs. The API currently binds to loopback by default.

Relevant advisories: [TinyMCE media injection](https://github.com/advisories/GHSA-vg35-5wq7-3x7w), [deepmerge-ts recursive graphs](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Re-run the audit before deployment; counts are a dated snapshot.

## Continue from here

Read `README.md`, `PROJECT_BRIEF.md`, and `contracts/README.md`, then continue with **Phase 2: curves, bounded routing, and live indexing**. Phase 1's fixed-price BUY opcode, complementary executor, market lifecycle, and local tests are implemented. Use their canonical order encoding and units; extend them deliberately for sell strategies and multiple fills. Confirm official Aqua deployment identity before broadcasting Horizon contracts and publishing the Subgraph. Keep zero trading fees, manual resale, USDC-only sharing across markets, and market-bound outcome validation. Credentials are local; do not reopen the TypeScript stack decision or ask for values already present.
