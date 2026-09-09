# Architecture

Horizon is a prediction market where makers publish **executable pricing curves** instead of
single limit prices, USDC liquidity is shared across markets through 1inch Aqua, and outcome
pairs are minted when complementary buyers meet. **Trading carries no fee of any kind** — no
maker, taker, routing or protocol fee. The only charge in the product is a one-off x402 payment
for the market-creation service, which is a separate paid service on Hedera.

## Processes

| Process | Responsibility |
| --- | --- |
| API (`src/server.ts`) | REST under `/api`, the built frontend, AdminJS inspection at `/admin`, and enqueueing durable work. |
| Worker (`src/worker.ts`) | pg-boss consumers for market creation and market resolution. Runs the only two operations that hold a server-side key. |
| PostgreSQL | Service workflow state: creation requests, payment intents, verification results, discount usage, resolutions, job runs, admin audit. Never a source of truth for balances or payouts. |
| Subgraph | Indexes markets, curves, fills, routes, collateral and resolution for discovery. |

## Trust boundaries

- **On-chain is authoritative.** Collateral, fill counters, payouts and market status live in the
  contracts. PostgreSQL holds workflow state only.
- **The Graph is discovery, not settlement.** Every quote refreshes wallet balances, allowances,
  fill counters and market status through RPC at a single block, rejects an indexed snapshot more
  than 64 blocks behind or on a reorged hash, and simulates the whole route before returning it.
- **User keys stay with users.** The API returns prepared, unsigned transactions for trading,
  curve publication and redemption. It signs nothing on a user's behalf.
- **Server keys stay server-side.** One key owns the registry and resolves markets. It can create
  markets and submit a disclosed result; it cannot spend from user wallets or withdraw collateral.
- **Resolution is centralized and disclosed.** A named resolver submits YES, NO or INVALID with an
  evidence reference after close. INVALID pays 0.5 USDC per outcome token. There is no dispute
  process in this release, and the UI says so.

## Trading

A curve is `p(x) = start + (end - start) · x^alpha` with `alpha ∈ {1,2,3}` and
`x = filled / maxShares`, priced in micro-USDC. BUY curves decline as the maker accumulates; SELL
curves rise as inventory leaves; equal endpoints are a fixed-price limit order. `CurveMath` and
the TypeScript quote service evaluate the same exact rational integral — BUY rounds down, SELL
rounds up — and an Anvil test compares 44 contract and TypeScript results.

A buy route can combine a SELL curve for the wanted outcome with a BUY curve for the opposite
outcome, because complementary minting delivers the same token. The off-chain allocator performs
a bounded chunk search over at most 32 Graph-discovered candidates and selects **at most four
fills**, which `RouteExecutor` settles atomically with a spend limit, a deadline and full rollback
on any failing leg. It computes exact amounts for the route it picks; it does not claim a global
optimum.

Only USDC is shared across markets. A YES or NO token is bound to one market and outcome, and
holding it creates no sell offer: a holder must explicitly publish a sell curve.

## Market creation

```
draft → human approval → optional World verification → x402 payment → durable creation job → market
```

1. **Draft.** A provider behind `MarketDraftProvider` proposes the question, outcomes, close time,
   category, resolution rules and evidence source, and flags duplicates. Both the hosted-model
   provider and the deterministic development provider read the live indexed market set, and every
   duplicate warning cites a market id that exists in it.
2. **Approval.** The draft is hashed; approval must quote that hash. A changed draft invalidates
   the approval, so nothing is charged for text a human did not see.
3. **Verification (optional).** See below. It only ever lowers the price.
4. **Payment.** See the payment flow below.
5. **Creation.** A pg-boss job derives `creationId = keccak256("horizon-creation:" + requestId)`
   and checks `marketByCreationId` before broadcasting, so a retry after a failed or ambiguous
   attempt records the existing market instead of creating a second one.

The workflow is an explicit state machine (`DRAFT → APPROVED → PAYMENT_REQUIRED → PAID → CREATING
→ CREATED`, plus `PAYMENT_REVIEW` and `FAILED`) and only moves along declared edges.

## Payment flow (Hedera x402)

The same resource serves browsers and agents: `POST /api/creation/requests/:id/payment`.

1. **Without a payment header** it answers **HTTP 402** with an x402 v2 declaration: a `resource`
   object and one `accepts` entry with `scheme: exact`, `network: hedera:testnet`, the `amount` in
   tinybar, `asset` (`0.0.0` for native HBAR), `payTo`, `maxTimeoutSeconds`, and an `extra` object
   carrying the per-request `nonce` and the facilitator's advertised Hedera `feePayer`. The
   declaration is also returned base64 in the `payment-required` header.
   The fee payer comes from the facilitator's `/supported` response; it is never assumed.
2. **The payer signs.** A browser wallet connects over Hedera WalletConnect and signs a partially
   signed transfer; an agent signs with its own key. Horizon never sees either key.
3. **With a `payment-signature` header** the server decodes the payload and checks that the
   `accepted` requirements echoed back match the ones it issued **field by field**, including the
   nonce and fee payer. A rewritten amount, receiver or nonce is refused before the facilitator is
   contacted.
4. **Verify, then settle** through Blocky402. The facilitator adds the fee-payer signature and
   submits the transfer; the settlement result is returned base64 in `payment-response`.
5. **The creation job is enqueued** and the request becomes `PAID`.

### Not charging twice

- One `PaymentIntent` per request, enforced by a unique index. Re-requesting requirements returns
  the same nonce and amount.
- Settlement is claimed with a compare-and-set from `REQUIRED`/`FAILED` to `SUBMITTED`, so
  concurrent submissions cannot both settle.
- An already settled intent short-circuits and replies with the stored receipt.
- Settlement references and payload fingerprints are unique, so an authorization cannot be
  replayed onto another request.
- An **ambiguous** facilitator result — a transport failure, a 5xx, or a failure that still carries
  a transaction reference — parks the request in `PAYMENT_REVIEW`. It is never retried
  automatically; an operator reconciles it from the ledger and the recorded reference.

## World verification

Verification is an eligibility and abuse-resistance signal, not proof of forecasting skill, and an
agent may act for a verified person. The IDKit widget runs client-side against an RP context the
server mints per request; the signal is the creation request id, so a proof produced for one
request cannot be replayed onto another. The server checks the action, the environment and the
signal binding, then forwards the complete IDKit result to World for verification.

Only the credential's **nullifier hash and identifier** are stored. The discount is applied once
per credential per UTC day, decided when payment requirements are issued, and is never granted
from a client-side claim. When access is not `granted` the verifier reports an explicit
unavailable state and the standard price applies.

## Administration

The operator screen inspects creation requests, payment intents, published curves (including
cancelled and exhausted ones), trades, fills, background jobs and markets. Its actions — retry a
paid creation, reconcile an ambiguous payment, queue a resolution — are deliberate service calls
with audit records, not generic database edits. AdminJS remains read-only. Resolution is refused
before a market's close time, because the market contract rejects a result until then.
