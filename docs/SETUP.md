# Running Horizon

Horizon is one Node service (HTTP API + built frontend), one worker process, PostgreSQL, a
Foundry contract project, and a Subgraph. Trading settles on Ethereum Sepolia with Circle test
USDC; the market-creation service is paid on Hedera testnet through x402.

## Requirements

- Node **24.10.0** (`.nvmrc`) and npm 11.6.1. `engine-strict` is on, so other majors are refused.
- Docker, for local PostgreSQL.
- Foundry 1.2.3, only for the contract and Anvil route tests.

## First run

```sh
npm ci
npm --prefix web ci
npm run setup:local     # writes .env and .local/admin-password.txt; refuses to overwrite .env
npm run db:up           # PostgreSQL 18 on 127.0.0.1:54329, creates horizon and horizon_test
npm run db:generate
npm run db:migrate
npm run db:test:migrate
npm run web:build       # the API serves web/dist when it exists
npm run dev             # API + frontend
npm run worker:dev      # in a second terminal: creation and resolution jobs
```

The application is then at `http://127.0.0.1:$PORT` (3001 by default). The operator screen is at
`/operator` and is deliberately absent from the navigation; AdminJS record inspection is at `/admin`.
Both use `ADMIN_EMAIL` and the password written to `.local/admin-password.txt`.

For frontend work with hot reload, `npm run web:dev` serves Vite on 5173 and proxies `/api`;
set `WEB_ORIGIN` to that origin so credentialed cross-origin requests are accepted.

## Configuration

`.env.example` documents every variable. The values that change behaviour most:

| Variable | Effect |
| --- | --- |
| `EVM_RPC_URL`, `HORIZON_*_ADDRESS`, `GRAPH_QUERY_URL` | Enable market data, quoting and creation. Without all of them `/api/markets` answers `503 trading_not_configured`. |
| `HEDERA_PAYMENT_MODE` | `live` settles through Blocky402. `simulated` performs **no** Hedera transaction and stores every record as simulated; never use it in production. |
| `CREATION_PRICE_UNITS`, `CREATION_DISCOUNT_BPS` | Creation price in the asset's smallest unit, and the verified-human discount. Defaults are 1 HBAR and 50%. |
| `WORLD_SELFIE_ACCESS` | `unknown`/`requested`/`granted`. Only `granted` attempts a live verification; anything else reports the unavailable state and applies no discount. |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | With a credential, drafting calls the model provider. Without one, a deterministic provider runs, still grounded on live indexed markets. |
| `EVM_DEPLOYER_PRIVATE_KEY` | Registry owner and disclosed resolver. Used only by the API/worker; it never reaches a browser. |
| `HEDERA_AUDIT_TOPIC_ID`, `HEDERA_AUDIT_ACCOUNT_ID`, `HEDERA_AUDIT_PRIVATE_KEY` | The public creation audit trail on HCS. With all three, statements are published to the topic; without them they are still recorded and can be published later. The signer's key is the topic's submit key and stays server-side. |

Secrets live in `.env` and `.local/`, both git-ignored. No user wallet key is ever sent to the
server: browser trades and curve publications are signed in the user's own wallet, and the Hedera
payment is signed by the payer's wallet or agent.

### The public audit trail

The trail is recorded from the first run and needs no configuration. To publish it, create a topic
restricted to a server-side audit signer, then point the app at it:

```sh
npm run audit:topic -- --dry-run    # reports the signer and submit key; sends nothing
npm run audit:topic                 # creates the topic, prints its id, spends a little testnet HBAR
# put the printed id in .env as HEDERA_AUDIT_TOPIC_ID, then restart the API and the worker
npm run audit:backfill -- --dry-run # statements for requests that completed before the trail existed
npm run audit:verify -- --latest    # read the published statements back from the mirror node
```

The audit signer is configured separately from the x402 payer and the Sepolia deployer. Its public
key becomes the topic's submit key, so only this service can append a statement. The key lives in
`.env` and is never logged, never returned by an API and never written into a published statement.

## Verification

```sh
npm run typecheck && npm test          # 18 unit tests
npm run test:integration               # 13 PostgreSQL tests; needs horizon_test
npm run test:routes                    # Anvil end-to-end quote, simulation and execution
npm run contracts:test                 # 39 Foundry tests
npm run vendor:verify                  # 329 pinned vendor file hashes
npm run build && npm run web:build
npm run subgraph:prepare && npm run subgraph:codegen && npm run subgraph:build
npm run doctor                         # sponsor readiness; exit 0 ok, 2 pending, 1 failed
```

`doctor` is read-only. It never sends a payment, deploys a contract, or infers success from the
mere presence of an environment variable.

## Deliberate write commands

These spend testnet funds and are never run by tests:

```sh
npm run deploy:phase2                  # deploy registry, router and executor
npm run subgraph:deploy
npm run demo:seed                      # fund a demo maker and publish curves
npm run agent:create -- --question "Will …?"          # agent x402 creation, review step
npm run agent:create -- --resume --approve            # pays and creates after human review
npm run audit:topic                                  # creates the HCS audit topic
```

`agent:create` prints the exact draft and exits with code 2 until `--approve` is passed, so an
agent run still has a human review gate before any charge.
