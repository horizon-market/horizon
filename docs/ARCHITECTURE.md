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

### Per-market order budgets

Shared USDC is available capital, not multiplied capital. Sharing it across markets is deliberate;
promising it twice **inside one market** is not, and is what this rule prevents.

**The accounting.** Commitments are grouped by `(maker, market, funding token)`, on normalised
addresses. The funding token is the single token an order can spend: USDC for a BUY whichever
outcome it names, and that market's YES or NO token for a SELL. So BUY YES and BUY NO share one
USDC budget, while a YES sell and a NO sell each draw on their own inventory. Outcome tokens are
never shared between markets in the first place; the grouping only stops two sell orders from
offering the same inventory twice.

- **Spendable** is `min(balance, allowance to Aqua)`. An allowance is not money, and money the
  spender may not move cannot be spent. Approving tokens reserves nothing.
- **An order's obligation** is the exact integer curve integral over the size it has left —
  `cumulative(maxShares) − cumulative(filled)` for a BUY, undelivered shares for a SELL. Never the
  share count, never the opening price times the size, never the original budget after a partial
  fill. A fixed-price limit order is a curve with equal endpoints and goes through the same
  arithmetic, so limit orders and curves are counted together.
- **The rule**: `committed in this group + this order's obligation ≤ spendable`. Equality is
  accepted; one base unit more is refused.
- **Reconciliation.** Each commitment is capped by the order's own Aqua allocation, because Aqua
  will not release more than it holds. Only two conditions release a commitment: the maker docked
  the order, or it filled to its size. A fill is not a cancellation — it reduces the obligation and
  the wallet by the same amount, so the room for a further order is unchanged. An order whose
  allocation has run out contributes nothing but is not released, because a later Aqua push can
  refund it. **An underfunded wallet never releases a commitment**: counting an outstanding order
  for less would invent room for another one.
- **Over budget.** If shared funds are spent in another market, withdrawn, or the approval is
  reduced, `committed` can exceed `spendable`. Available capacity is then zero, the condition is
  reported as `overcommitted`, and no further order is admitted here until the maker cancels one or
  restores the funds. Existing orders are untouched: nothing is auto-cancelled, auto-resold or
  resized, and there is no global reservation.

**Where it is enforced.** In `OrderBudget`, the ledger `HorizonSwapVM` deploys and owns, at the
moment an order is admitted. Publication is therefore two transactions:

1. `Aqua.ship` — records the allocation the order may draw on.
2. `HorizonSwapVM.admitCurve` — checks this market's budget and makes the order executable.

They cannot be one transaction: Aqua's `ship` has no application callback, so the router cannot be
consulted while it runs. Anyone can ship a strategy naming this router without asking Horizon, which
is exactly why the check cannot live in the API. **An order the router has not admitted never
fills** — `_runCurve` and the Phase 1 BUY opcode both refuse it — so a direct Aqua publication is
inert: it holds the maker's allocation, consumes no budget, and is filtered out of discovery
(`admitted` in the subgraph) and of quoting (the quote service drops unadmitted candidates by RPC).
Its maker can still dock it to take the allocation back, and the Portfolio lists it as **Not
published** with that instruction.

**Concurrency.** Two publications racing each other cannot both pass, because admission is a
transaction: the second reads the first. The API check is advisory — it is read at one block and
any figure can move before the maker signs — and nothing is reserved for a prepared or claimed-but
-unconfirmed transaction. The API refuses to prepare a publication at all when the ledger cannot be
read (`order_budget_unavailable`, HTTP 503) rather than treating an unknown budget as an empty one.
The budget is never derived from indexed data: the ledger's `openOrders` list is the complete set of
a maker's commitments in a market by construction, so a stale or unavailable Graph can neither hide
a commitment nor invent one.

**What this does not do.** It does not reserve funds, guarantee that any order fills, or coordinate
across markets: two markets can each commit the same wallet in full, and a transaction in one can
leave the other over budget. It does not deactivate orders automatically. And it is per wallet — it
says nothing about competing transactions racing for the same balance at fill time, which the
executor's own limits and rollback handle.

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

## Public audit trail (Hedera Consensus Service)

Three statements about a creation request are published to one HCS topic, giving a public,
timestamped, ordered record that links an **approved draft** to the **Hedera payment that settled
for it** and to the **Sepolia market it produced**.

| Statement | Contents |
| --- | --- |
| `DRAFT_APPROVED` | request id, approved draft hash |
| `PAYMENT_SETTLED` | the above, plus network, asset, amount in base units, settled transaction reference |
| `MARKET_CREATED` | the above, plus the payment reference, EVM chain id, market address, confirmed deployment transaction hash |

**What it attests, and what it does not.** HCS records *Horizon's own statements* and the order in
which it made them. It does not independently verify the Hedera payment, the Sepolia deployment or
the eventual outcome of a market. Each of those is checked at its own source — the Hedera mirror
node, a Sepolia explorer, the market contract — and the references in the statements are what let
anyone do that. This sentence is returned by `/api/config`, embedded in every request view, and
printed on the creation screen, so no surface can imply a stronger guarantee.

### The schema

`horizon.audit.v1`, defined in `src/audit/events.ts`. Every message is validated against a
**strict** closed schema immediately before submission and built from an explicit field list
rather than spread from a database row, so a private key, an access token, a World proof, a
credential identifier or a requester address cannot reach the topic even by mistake. The largest
statement is well under the 1024-byte HCS message limit, and submission sets `maxChunks(1)` so a
statement that outgrew it would be refused rather than silently split.

Encoding is canonical: key order is fixed at encode time rather than inherited from the stored
`jsonb`, so a message is a function of its fields alone and a mirror-node readback can be compared
byte for byte.

**Event id.** `sha256("horizon.audit.v1:" + requestId + ":" + type)`, and for a child of an event
`+ ":" + position` — the same derivation idiom as the on-chain `creationId`. It is stable, it is
carried inside the message, and it is the key readers deduplicate on.

**Order.** A per-request `sequence` is derived from the type and position (`DRAFT_APPROVED` = 1,
`PAYMENT_SETTLED` = 2, `MARKET_CREATED` = 3 + position), never counted. Counting rows would let
two concurrent writers claim different places in the order and would turn a retried write into a
new event.

### Durability: an outbox, not a call

Each statement is written to the `AuditEvent` table **inside the same database transaction as the
workflow transition it records**. A request cannot be approved, a payment cannot be recorded as
settled and a market cannot be recorded as created without its statement being queued, and the
statement cannot exist without the transition. Publication happens afterwards, on the existing
pg-boss infrastructure.

The consequence is the point of the design: **Hedera being unreachable cannot cause a second
payment, a second deployment, or a failed creation.** Nothing on the paid path waits for the
topic, and a publication failure is recorded on the outbox row, never on the request.

Two success statements are deliberately late: `PAYMENT_SETTLED` is written only with the
settlement receipt in hand, and `MARKET_CREATED` only after the deployment receipt is confirmed
and the registry names the market.

### Publication, retries and unknown outcomes

The worker publishes a request's open statements **in ascending sequence and stops at the first
one it cannot confirm**, so a payment statement that has not landed can never be overtaken by the
market statement that followed it. At most one publication job per request runs at a time
(`singletonKey`), and a periodic sweep re-enqueues whatever is still due — which is what recovers
a wake-up refused while a job was running, a worker restarted mid-publication, and any statement
waiting out its exponential backoff.

Four states are kept apart, and only one of them means published:

- `PENDING` / `PUBLISHING` — queued, or claimed by a worker. No consensus timestamp.
- `UNCONFIRMED` — **submitted, outcome unknown.** Never reported as published.
- `PUBLISHED` — confirmed, with a Hedera transaction id, a consensus timestamp and a topic
  sequence number, all stored.
- `FAILED` — refused for a reason that will not change (`INVALID_TOPIC_ID`, `UNAUTHORIZED`,
  an oversized message).

**Delivery is at least once, and is never described otherwise.** HCS orders and timestamps
messages; it does not deduplicate application event ids. An unknown outcome is therefore
reconciled first — the mirror node is searched for the statement's event id, and a statement
already on the topic is recorded with the consensus timestamp and sequence number it actually has
rather than being sent again. Only when reconciliation cannot find it is it resubmitted, which can
put a second copy on the topic. Readers deduplicate by `eventId`. A statement whose outcome is
still unknown when its retry budget runs out is parked as `UNCONFIRMED` for an operator rather
than being declared either way.

### Backfilled statements

`npm run audit:backfill` records statements for requests that completed before the trail existed.
Every such row is marked `backfilled`, the published message carries `"backfilled": true`, and
`occurredAt` carries the event time the service actually recorded. **A backfilled statement's
consensus timestamp is the time Horizon published it, not the time the event happened**, and the
API and the creation screen say exactly that on the row itself. Nothing represents a backfilled
statement as having an original event-time consensus timestamp.

### Reading and verifying it

The trail travels with the request it belongs to: `GET /api/creation/requests/:id` includes an
`audit` block, under the request's existing bearer-token authorization and disclosing only fields
the request view already returns. `GET /api/creation/requests/:id/audit?verify=1` additionally
reads each confirmed statement back from the mirror node and compares it byte for byte, which is
the check a third party can repeat against the same public URLs without trusting the API at all.
`npm run audit:verify` does the same from the command line, and `npm run doctor` re-checks that the
topic accepts messages only from the configured audit signer.

The same trail is public under the identifiers a reader actually holds, with no token:
`GET /api/audit/events/:slug` returns every statement across the requests that built an event,
oldest request first, and `GET /api/audit/markets/:address` returns the trail of the request that
deployed one market — the whole request, since one payment covered every child — naming the
statement that records this deployment. Both accept `?verify=1` under a tighter rate limit, since a
verification is one mirror-node read per published statement. The envelopes add only what is
already public: the event's slug and title, the child's position and outcome label, and the
request's id, kind and creation time — the id is already inside every published message. Request
status, requester, tokens and payment details are never included. The event and market pages read
these to show the trail beside the markets it is about; a market that predates the trail simply
shows none.

`/audit` explains the trail the way `/curves` explains curves: by doing it. The page reads the
latest messages on the topic straight from the mirror node **in the browser** — the request never
passes through Horizon — decodes each one, and recomputes its `eventId` from the published recipe,
so the derivation is demonstrated rather than asserted. It is linked from every audit card, from the
payment step, and from the footer; it is deliberately not a second help link in the top bar, which
is reserved for what a trader must understand to trade.

### Configuration

`HEDERA_AUDIT_TOPIC_ID`, `HEDERA_AUDIT_ACCOUNT_ID` and `HEDERA_AUDIT_PRIVATE_KEY` configure a
server-side audit signer whose public key is the topic's **submit key**, so no other account can
append to the trail. The key is never logged, never returned by an API and never written into a
statement. `npm run audit:topic` creates such a topic. Without these settings the outbox still
records every statement — it simply publishes nothing, and says so rather than presenting an empty
trail as a complete one.

**Only the process that publishes needs the signer.** Publication runs on the worker, so in a
split deployment `HEDERA_AUDIT_PRIVATE_KEY` belongs there alone — the same rule
`EVM_DEPLOYER_PRIVATE_KEY` already follows. The API needs the topic id, the network and the mirror
URL to render the trail, and reads and verifies it with no key at all: `configured` (a topic
exists) is deliberately separate from `publishing` (this process can submit), so an API that
cannot publish never reports the trail as absent.

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

## Events: grouped markets and imported definitions

An **event** is a durable Horizon-owned grouping of independent binary markets. Every child keeps
its own market contract, its own collateral escrow, its own outcome tokens, its own trading and its
own resolution; the event adds a title, shared context, ordered outcome labels, and — for an import
— the record of where the definitions came from. A market that belongs to no event is standalone
and behaves exactly as it always has, including its URL.

**Membership alone says nothing about outcomes.** Two kinds of grouping are distinguished:

- `COLLECTION` — grouped for context. Nothing requires one of them to win, and the prices across
  them are not a distribution.
- `EXCLUSIVE` — the source or the author states that the rules pick exactly one winner.

Even for an `EXCLUSIVE` event the guarantee is **backend-only**. The resolution workflow refuses a
second `YES` while a sibling is already resolved `YES` on chain or has a `YES` resolution queued.
The market contracts hold no notion of a group and do not enforce it, so a resolver key used
outside this workflow could still produce two `YES` results. `NO` and `INVALID` are never blocked:
a cancelled or void underlying event has to be settleable across the whole group. This limitation
is stated in `/api/config`, on the event page, on the market page and on the operator screen.

Shared collateral and negative-risk token conversion between siblings are **not implemented**.

### Where events live

Events are service metadata, in the same tier as creation drafts and payment intents — not a
projection of chain state. `MarketEvent` holds the event, `EventMarket` its ordered children and
their outcome labels, and a child gains a `marketAddress` only once its market is actually deployed.
`EventMarket.marketAddress` is unique across every event, so a market belongs to at most one event
and browsing can never draw the same market twice. An imported definition is never stored as if it
were an indexed, deployed market.

### Importing definitions

Importing copies **definitions only** — the question, the outcome labels and their order, the
resolution criteria, the evidence source and the dates. Polymarket prices, liquidity, volume,
order books and settlement state are read only so they can be recognised and discarded; they never
become Horizon data, and they are excluded from the stored source snapshot.

- **The address is parsed, not fetched.** Only the page shapes Polymarket actually serves are
  accepted: `polymarket.com/event/<event>`, `.../event/<event>/<market>`, `.../market/<market>`
  and `.../sports/<league>/<event>` — the last being how sports events are addressed, with the
  event slug in the final segment. A league on its own (`/sports/epl`) is a listing page and is
  refused, as is any other section prefix. The slug is validated, and the backend builds its own
  request path against the fixed `POLYMARKET_API_ORIGIN`. No user-supplied URL is ever fetched.
- **Preview first.** `POST /api/creation/imports/preview` reports exactly what would be created and
  why anything is refused. It writes no row, charges nothing and deploys nothing.
- **Refusals are explicit.** Closed, archived or inactive markets; outcome sets that are not
  YES/NO, with the actual outcomes named; placeholder outcomes the source has not filled in
  (`Team H`, `Other`, `TBD`); missing resolution criteria; and close times outside Horizon's
  bounds, with the bound named. A blocking reason removes that child rather than repairing it.
- **Trading close is distinguished from event start and settlement.** Horizon's close time is when
  trading stops; the source's end date is when it settles the question. Where the source's start
  time and end date disagree, Horizon closes at the earlier of the two and marks the mapping as
  needing review.
- **Rules are preserved and changes are stated.** The source criteria are kept verbatim in the
  snapshot and used as the standard; Horizon's settlement terms are *appended*, never substituted,
  and every change — the addition, any shortening, a derived evidence source, a date decision — is
  listed against that child in the review.
- **Settlement is not delegated.** An imported market is resolved by the disclosed Horizon
  resolver, not by Polymarket or UMA.
- **Duplicates are detected.** `(sourceProvider, sourceEventId)` is unique, so re-importing a page
  answers with links to the Horizon markets that already exist instead of a second bill.

### Groups, pricing and partial failure

- One creation request can carry several children. Pricing is the existing per-market policy: the
  standard price per market created, and the verified-human discount applied once to the request
  total rather than once per child. The group price is shown explicitly before approval.
- Approval binds to a hash of the **whole plan** — event metadata, the selected children's exact
  drafts, their labels and order, the provenance, and the price shown. Changing the selection
  changes both the outcome set and the price, so it invalidates any earlier approval, and it is
  refused outright after approval.
- A selection narrower than the source's full outcome set is never labelled exhaustive.
- Each child derives its on-chain creation id from the request id **and its position**. A
  standalone request keeps the original derivation byte for byte, so markets created before events
  existed are still found rather than deployed a second time.
- Deployment walks the selected children in order and attempts every one. A retry skips anything
  already `CREATED` and re-checks the registry before broadcasting, so a partial failure never
  recreates a market. The payment settles once, for the request; nothing on the retry path can
  charge again.

## Administration

The operator screen inspects creation requests, payment intents, published curves (including
cancelled and exhausted ones), trades, fills, background jobs and markets. Its actions — retry a
paid creation, reconcile an ambiguous payment, queue a resolution — are deliberate service calls
with audit records, not generic database edits. AdminJS remains read-only. Resolution is refused
before a market's close time, because the market contract rejects a result until then.
