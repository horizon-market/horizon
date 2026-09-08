# Horizon foundation — setup and continuation

Implementation snapshot: September 8, 2026. Phase 0's local foundation works. Its live-integration exit criteria remain open; the user will provide accounts and API access later.

Local Git history preserves the work in increments: `209555f` records the planning baseline, `196ca79` pins official contract sources and the settlement probe, and `d13a8c4` adds the tested TypeScript/admin/ORM/worker foundation. No remote repository or public deployment has been created.

## Local setup

Use Node **24.10.0** (`.nvmrc`) and npm **11.6.1**. The workspace also has Node 26 on its default PATH; select Node 24 before running npm. Do not upgrade Prisma independently of the AdminJS adapter.

```sh
cd /Users/xana/work/ethglobal2026/horizon
nvm use
npm ci
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm run dev
```

`setup:local` creates `.env` and a random admin password in `.local/admin-password.txt`, both private and ignored by Git. It refuses to overwrite an existing `.env`. In this workspace these files have already been created, so skip that step. The admin email is `admin@horizon.local`. Open [the local admin](http://127.0.0.1:3001/admin) and read the password from the local file; do not commit or paste it into a task.

Docker Compose provides PostgreSQL on loopback port **54329** and retains data when stopped with `npm run db:down`. Its fixed password is for this local database only. Docker was not running during implementation, so verification used the installed PostgreSQL **18.2** in an isolated cluster under `.local/pgdata`, on the same port. The native test cluster uses trust authentication on loopback. Stop it before starting the Compose database on that port:

```sh
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D .local/pgdata stop
```

Restart that existing native cluster, if preferred:

```sh
/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D .local/pgdata -l .local/postgres.log -o "-p 54329 -h 127.0.0.1 -k /Users/xana/work/ethglobal2026/horizon/.local/pgsocket" start
```

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

Database integration tests require a **dedicated localhost database named `horizon_test`**. They refuse other database names/hosts. The local native instance already has it. With Compose, create it once and apply the migration:

```sh
docker compose exec db createdb -U horizon horizon_test
DATABASE_URL=postgresql://horizon:horizon_local_only@127.0.0.1:54329/horizon_test npm run db:migrate
TEST_DATABASE_URL=postgresql://horizon:horizon_local_only@127.0.0.1:54329/horizon_test npm run test:integration
```

Verified locally: TypeScript typecheck/build; two unit tests; three actual PostgreSQL integration tests covering authenticated read-only admin, persisted jobs across worker startup/restart, duplicate effects, and retry; three Foundry tests covering official-source token transfers, callback ordering, and shared-wallet depletion. Prisma migration diff against the live test schema reported no difference. The browser login page rendered successfully. The GitHub workflow runs the local checks after push, but remote CI has not run yet.

The macOS sandbox prevented PostgreSQL shared-memory initialization and caused Foundry's OS proxy lookup to crash; those commands succeeded outside the sandbox. These were environment limitations, not passing results inferred from failed tests.

## Sponsor readiness

```sh
npm run doctor
```

This read-only command reports `ok`, `pending`, or `failed` without printing secrets or credential-bearing URLs. Exit code **0** means all recorded checks pass, **2** means work/access remains pending, and **1** means a configured check failed. It never sends a payment, deploys a contract, or claims account verification from merely present environment variables.

On September 8 the public Blocky402 `/supported` endpoint advertised `exact`, `hedera:testnet`, x402 version 2. This establishes advertised capability only. Remaining work:

- Sepolia RPC, funded deployment wallet/test USDC, official Aqua bytecode verification, and Horizon deployment.
- Hedera receiver/payer accounts, a funded agent wallet, WalletConnect project, and real browser and agent paid requests through Blocky402.
- Graph Studio/deploy access and a deployed Subgraph once Horizon emits relevant events.
- World app/action configuration, Selfie Check/Sandbox access, and real credential verification. Access status remains unknown.

Use `.env.example` for configuration names. Do not send private keys in task messages. Public deployed addresses, endpoints without secrets, and transaction hashes can be added to documentation after verification. All four sponsors remain required.

## Dependency findings before public release

Versions are exact in `package.json` and `package-lock.json`: Express 4.22.2, AdminJS 7.8.17, its Express adapter 6.1.1 and Prisma adapter 5.0.4, Prisma/client 6.19.3, pg-boss 10.4.2. The Prisma adapter declares support for Prisma 5/6 and AdminJS 7. The selected combination is now tested locally.

The install audit on September 8 reported **46 findings: 42 moderate and 4 high, no critical**. The four high package entries trace to two causes: TinyMCE bundled transitively by AdminJS's design system, and deepmerge-ts in Prisma's development configuration tooling. Read-only Horizon resources do not use rich-text editing, and the CLI does not process uploaded Prisma configs; this does not erase the advisories. A non-breaking `npm audit fix --dry-run` proposed no dependency changes. Do not run `--force` and silently downgrade the tested stack. Resolve or explicitly assess these dependencies before exposing the admin publicly or enabling rich-text inputs. The API currently binds to loopback by default.

Relevant advisories: [TinyMCE media injection](https://github.com/advisories/GHSA-vg35-5wq7-3x7w), [deepmerge-ts recursive graphs](https://github.com/advisories/GHSA-ggr8-5vv4-36mx). Re-run the audit before deployment; counts are a dated snapshot.

## Continue from here

Read `README.md` and `PROJECT_BRIEF.md`, then implement **Phase 1: market lifecycle and the first backed complementary match**. The local protocol probe and its boundaries are described in `contracts/README.md`. Keep zero trading fees, manual resale, USDC-only sharing across markets, and market-bound outcome validation. Live sponsor access can be added when the user supplies it without reopening the TypeScript stack decision.
