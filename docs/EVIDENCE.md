# Public evidence and disclosed roles

Everything below was verified against live networks. Anything not yet proven is listed in
"Outstanding" rather than implied.

## Deployed contracts — Ethereum Sepolia (chain 11155111)

| Contract | Address | Deployment transaction |
| --- | --- | --- |
| `MarketRegistry` | [`0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1`](https://sepolia.etherscan.io/address/0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1) | [`0x7bb78c17…`](https://sepolia.etherscan.io/tx/0x7bb78c175b6406d051977cb6b4e52bef40c1dbe080acf044d2b0e8b6cf4b9538) |
| `HorizonSwapVM` | [`0x2b7592171cc7cfaa21dd60b49c81d68cf584302d`](https://sepolia.etherscan.io/address/0x2b7592171cc7cfaa21dd60b49c81d68cf584302d) | [`0x0313620a…`](https://sepolia.etherscan.io/tx/0x0313620a3f4530f599df4f4e734233944e0920aff49c01279dc9e855a6061c93) |
| `OrderBudget` | [`0x563D51c62260F484C5765712fd9716704cF266A2`](https://sepolia.etherscan.io/address/0x563D51c62260F484C5765712fd9716704cF266A2) | deployed by the router in the same transaction |
| `RouteExecutor` | [`0x657b5cf110bed745c5b3f33c77d61855abb4cfa9`](https://sepolia.etherscan.io/address/0x657b5cf110bed745c5b3f33c77d61855abb4cfa9) | [`0x8073fe02…`](https://sepolia.etherscan.io/tx/0x8073fe029908ce6f2afca8da9bfb66df9a3d979166e4dfd10e7fd1c3b9f11013) |

The router and executor were redeployed on September 10, 2026 to enforce per-market order budgets.
The registry is unchanged, so every market created before then still exists and still resolves.
Orders published to the superseded router `0xf155c2ad43d020b601ee51a7e086112a5d00240f` stay
there and are not migrated; the current Subgraph indexes only the router above. The previous
addresses are kept in `deployments/sepolia.json` under `superseded`.

Dependencies, not deployed by this project: official 1inch Aqua router
`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` and Circle test USDC
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. The Aqua deployment is the upstream `AquaRouter`
wrapper; Sourcify reports an exact runtime match and its core sources match the vendored pins byte
for byte. `deployments/aqua-verification.json` records the provenance and observed runtime hash,
and `npm run doctor` re-checks the live runtime hash against it.

Wiring verified on chain: the router points at the registry and at Aqua, the executor points at
the router, and the registry points at USDC. The router also deploys and owns `OrderBudget`, and
the two name each other — `router.budget()` and `budget.app()` — so no configuration can point at
the wrong ledger.

### Per-market order budgets, checked live

A maker order is published in two steps: `Aqua.ship`, then `HorizonSwapVM.admitCurve`. The router
refuses to fill any order it has not admitted, which is what makes the budget rule binding rather
than advisory — `Aqua.ship` has no application callback, so anyone can publish a strategy naming
the router without asking Horizon.

On September 10, 2026 against the deployed contracts: an order committing exactly the wallet's whole
approved USDC budget was admitted and left zero capacity; a further order owing **one base unit** was
accepted by `Aqua.ship` and refused by `admitCurve` with `MarketBudgetExceeded` (`0x90ac6f09`). While
shipped but unadmitted it committed nothing. Docking both released every commitment. Transactions
and figures at each step: [`deployments/order-budget-evidence.json`](../deployments/order-budget-evidence.json).

## Indexing

Subgraph Studio version `0.3.2`, queried live at
`https://api.studio.thegraph.com/query/1758973/horizon/0.3.2`. This is a working Studio
deployment, not a claim of decentralized-network publication. It indexes markets, curves, fills,
routes, collateral and resolution, and validates Aqua publications against the deployed router
rather than trusting arbitrary `Shipped` bytes. It also records `Strategy.admitted` from the
router's `StrategyAdmitted` event, and discovery serves only orders that are both active and
admitted — so a strategy shipped straight to Aqua is never presented as depth.

## Trading — atomic two-curve route

Transaction
[`0xe59d75c5…`](https://sepolia.etherscan.io/tx/0xe59d75c5dc159603433faa068a7cd6bd62e1f09fb8b273705040c349f1557aba)
bought 2 YES across **two curves in one atomic transaction**, escrowing 2 USDC of collateral from
0.816666 maker USDC and 1.183334 taker USDC. One maker wallet backed curves in two markets; the
fill left 0.183334 USDC, which made the previously simulated purchase in the other market
unavailable, and replaying the old calldata was rejected. The Graph indexed one route, two fills,
the collateral change and both exhausted curves. Details: `deployments/phase2-evidence.json` and
`deployments/phase2-indexed.json`.

## Creation — agent-paid, end to end

An agent-owned client completed a real paid creation request. `deployments/phase3-agent-evidence.json`
records it, and `npm run doctor` re-verifies every claim below against the Hedera mirror node, the
Sepolia RPC and The Graph.

| Step | Evidence |
| --- | --- |
| Hedera x402 payment | [`0.0.7162784@1788954987.856633335`](https://hashscan.io/testnet/transaction/0.0.7162784-1788954987-856633335) — `SUCCESS`, 100000000 tinybar (1 HBAR) transferred to the configured receiver, settled through Blocky402 on `hedera:testnet` |
| Market creation | [`0x465d78fa…`](https://sepolia.etherscan.io/tx/0x465d78fa22ade4503a1693993f947379ecbb6d5601262de284144938a44b7860) in block 11667797, called against the registry |
| Market | [`0xBC11a878771E75a1C32bfB23A0B40db704F27432`](https://sepolia.etherscan.io/address/0xBC11a878771E75a1C32bfB23A0B40db704F27432), YES `0xa0D0a025eA8960e06a0A832BC05Cb352b13280c0`, NO `0x3727A9b24256525036D343cbe2b8ADb11Fef3FF6` |
| Idempotency binding | `marketByCreationId(keccak256("horizon-creation:" + requestId))` resolves to that market, so a retry cannot create a second one |
| Indexing | The market is live through The Graph and was found at indexed block 11667798 |

The question was drafted from live indexed market data, reviewed and approved by a human before
any charge, and the whole run is reproducible with `npm run agent:create`.

## Public creation audit trail — Hedera Consensus Service

Topic [`0.0.10473191`](https://hashscan.io/testnet/topic/0.0.10473191) on Hedera testnet, created
September 11, 2026 in transaction `0.0.10424539@1789115559.545035814`. Its **submit key is the
audit signer's public key**, so no other account can append to the trail; the mirror node reports
`submit_key` and `admin_key` as `034b845654…97333c`, the on-ledger key of `0.0.10424539`. Memo:
`Horizon market-creation audit trail. Schema horizon.audit.v1. Horizon's own statements.`

**What this attests.** HCS records that Horizon made these statements and the order in which it
made them. It does **not** verify the Hedera payment, the Sepolia deployment or any market
outcome. The references inside each statement are what let a reader check those at their own
sources, which is done below. Delivery is at least once — a reconciled resubmission can appear
twice, and readers deduplicate by `eventId`.

Thirteen statements are published, at topic sequence numbers 1–13, contiguous and in order. All
thirteen were read back from the mirror node and matched the stored statement **byte for byte**.

### One complete chain: request `b6414cd3-7110-4832-978b-8ccf1202ce00`

| # | Statement | Consensus timestamp | Message |
| --- | --- | --- | --- |
| 1 | `DRAFT_APPROVED` | `1789115749.746207104` | [messages/6](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10473191/messages/6) |
| 2 | `PAYMENT_SETTLED` | `1789115752.870222104` | [messages/7](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10473191/messages/7) |
| 3 | `MARKET_CREATED` | `1789115756.085022104` | [messages/8](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10473191/messages/8) |

The three statements share one `draftHash` — `73b6e0d6…25b0fdf0`, the same canonical hash the human
approved — and chain the approval to the payment and the payment to the market:

```json
{"schema":"horizon.audit.v1","type":"MARKET_CREATED","eventId":"e2a3220d…b2590e31",
 "requestId":"b6414cd3-7110-4832-978b-8ccf1202ce00","occurredAt":"2026-09-10T09:28:37.847Z",
 "draftHash":"73b6e0d6…25b0fdf0","backfilled":true,
 "payment":{"transactionRef":"0.0.7162784@1789032315.551580133"},
 "market":{"chainId":11155111,"address":"0x2CD0f62990c950528fdf27D78B06992B805BCab9",
           "transactionHash":"0xc4fe069c…4ae7d78a"}}
```

**Each reference checked at its own source**, which is the point — HCS did not establish any of it:

| Reference | Checked against | Result |
| --- | --- | --- |
| `0.0.7162784@1789032315.551580133` | Hedera mirror node | `SUCCESS`, 50000000 tinybar (0.5 HBAR, the verified-human price) transferred to the configured receiver |
| `0x2CD0f629…805BCab9` | `MarketRegistry.isMarket` on Sepolia | `true` |
| request id → market | `marketByCreationId(keccak256("horizon-creation:" + requestId))` | resolves to that market, so a retry cannot create a second one |
| `0xc4fe069c…4ae7d78a` | Sepolia RPC receipt | status `0x1`, block 11674059, called against the registry |

### Backfilled and live statements are distinguished

Twelve of the thirteen are **backfilled** — recorded for requests that completed before the trail
existed. Each carries `"backfilled": true` and an `occurredAt` holding the event time the service
recorded; **their consensus timestamps are publication times, not event times**, and the API, the
creation screen and `audit:verify` all say so on the row. Nothing presents them otherwise.

The thirteenth is live. Request `50b78d10-f0b6-4aa3-8662-e9c2fab30e3e` was drafted and approved
through the running service on September 11, 2026; the statement was written to the outbox in the
approval transaction and published by the worker about ten seconds later:

| Field | Value |
| --- | --- |
| Statement | `DRAFT_APPROVED`, `backfilled: false` |
| Approved at | `2026-09-11T08:43:55.645Z` |
| Consensus at | `2026-09-11T08:44:06.130Z` (`1789116246.130532104`) |
| Hedera transaction | [`0.0.10424539@1789116237.208115829`](https://hashscan.io/testnet/transaction/0.0.10424539-1789116237-208115829) |
| Message | [messages/13](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10473191/messages/13) |

Its draft was produced with the Graph-grounded duplicate context reported **unavailable**, because
Graph Studio was returning HTTP 429 at the time and the API refuses to draft against an assumed
empty market set. Everything else — the approval gate, the transactional outbox write, the worker,
the topic — is the ordinary path.

Recorded in [`deployments/audit-evidence.json`](../deployments/audit-evidence.json), and
`npm run doctor` re-checks both the topic's submit key and the published statements.

The trail is also readable without a token, by event slug or market address, and each event and
market page shows it. For example, the Sunderland AFC vs. Arsenal FC import — five statements at
sequence numbers 14–18:

```sh
curl -s https://horizon-production-8c50.up.railway.app/api/audit/events/sunderland-afc-vs-arsenal-fc \
  | jq '.audit.events[] | {type, status, sequenceNumber, transactionUrl}'
curl -s 'https://horizon-production-8c50.up.railway.app/api/audit/markets/0xa1a26d4b1effcae156c39ba6caa1ce11ea14dee3?verify=1' \
  | jq '.market, .audit.verification'
```

## Disclosed centralized roles

This MVP is deliberately centralized in two places, and both are stated in the product UI.

- **Creation authority.** `MarketRegistry` is owned by
  `0x243fBaeE0E81EfbC5900F0934f6f4Aa66a249D31`. Only that owner can call `createMarket`; anyone can
  *request* a market through the paid service. Its two-step ownership transfer changes future
  creation authority only — it can never alter an existing market's rules or resolver.
- **Resolution authority.** Every market created by the service takes that same address as its
  immutable `resolver`. After close it may submit YES, NO or INVALID **once**, with a non-empty
  evidence reference recorded on chain. YES/NO pays 1 USDC per winning token; **INVALID pays 0.5
  USDC per outcome token**, with each holder's half-unit remainder retained for their next claim.
  There is no dispute process, no timeout fallback and no administrator sweep of collateral.

Neither role can spend from a user's wallet, withdraw collateral, mint unbacked outcomes, or reset
a curve's filled counter.

## Local verification

Verified on the current tree:

| Check | Result |
| --- | --- |
| `npm run contracts:test` | 39 Foundry tests, including three 256-case fuzz properties |
| `npm run test:routes` | Anvil end-to-end: 44 contract/TypeScript pricing comparisons, whole-route simulation, execution, exhaustion and reorg rejection |
| `npm test` | 18 TypeScript unit tests |
| `npm run test:integration` | 13 PostgreSQL tests covering payment idempotency, requirement binding, ambiguous settlement, discount limits, authorization and job durability |
| `npm run typecheck`, `npm run build`, `npm run web:typecheck`, `npm run web:build` | pass |
| `npm run vendor:verify` | 329 pinned vendor files unchanged |
| Subgraph `prepare`/`codegen`/`build` | pass |
| `npm run doctor` | Sepolia, funding, Blocky402 capability, agent payment, Graph endpoint, indexed agent market, on-chain agent market, audit topic, published audit statements and deployment wiring all `ok` |

## Outstanding

These are implemented but not yet demonstrated live, and are reported as `pending` by `doctor`:

- **Browser-wallet Hedera payment.** The Hedera WalletConnect client is implemented and the
  payment screen renders live requirements including the facilitator's fee payer, but no
  browser-wallet settlement has been completed and recorded. It needs a funded testnet wallet and
  a human approval.
- **World Selfie Check.** Access is granted, a credential has been verified in Sandbox against
  the production deployment, and a creation has been paid at the discounted price. The
  transaction and request ids are not yet recorded here. See
  [WORLD_FEEDBACK.md](WORLD_FEEDBACK.md).
- **Hosted-model drafting.** No AI credential is configured, so the deterministic provider runs.
  It is grounded on the same live Graph data and is labelled `development` wherever it appears.
- **Demo recording.**
