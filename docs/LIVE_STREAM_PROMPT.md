# Horizon — live chain data via The Graph Substreams, notifications, and global SSE

You are implementing real-time market data for Horizon (this repo). Today every read is served from a
Postgres mirror of the Subgraph that a periodic worker job rebuilds (`src/trading/projection.ts`,
`syncMarkets`, every `MARKET_SYNC_INTERVAL_MS`), with fallback to The Graph when the mirror is stale
(`MarketService.read` in `src/trading/markets.ts:54`). A new market or a fill therefore appears only
after the Subgraph indexes it AND the next sweep runs. The goal is: a market, its creator's
notification, liquidity and trade history update within seconds of the block, without depending on
the periodic sync — and without corrupting the mirror.

Read these before writing code: `docs/ARCHITECTURE.md`, `OPERATIONS.md`, `prisma/schema.prisma`,
`src/trading/projection.ts`, `src/trading/markets.ts`, `src/trading/service.ts` (quote path),
`src/creation/service.ts` (`runCreation`, `runGroupCreation`, `authorize`), `src/creation/onchain.ts`
(`creationId`), `src/services.ts`, `src/worker.ts`, `src/jobs.ts`, `src/app.ts`, `subgraph/subgraph.yaml`,
`subgraph/src/mapping.ts`, `web/src/App.tsx`, `web/src/hooks.ts`, `web/src/creations.ts`, `web/src/api.ts`,
and the existing test style in `test/projection.test.ts` / `test/*.integration.test.ts`.

Match the codebase's conventions exactly: dense TypeScript, comments that explain *why* (not what),
addresses stored lower-cased, uint256 as decimal strings, secrets never logged (see the redaction in
`GraphProvider.query`), `node:test` + `assert/strict`, Prisma migrations under `prisma/migrations/`,
services wired once in `buildServices`. Do not add dependencies beyond what Substreams consumption
needs (`@substreams/core`, `@substreams/node`, `@bufbuild/protobuf`); `pg` and `viem` already exist.

## 1. Substreams package: `substreams/` (Rust module `horizon_events`)

Create `substreams/` with `Cargo.toml`, `substreams.yaml`, `proto/horizon/v1/events.proto`, `abi/`
(copy from `subgraph/abis/`), `src/lib.rs`, and an `npm run substreams:build` / `substreams:pack` script.
Network: sepolia. Addresses and start blocks come from `subgraph/subgraph.yaml` (registry
`0xa1151c78…`, router `0x2b7592…`, executor `0x657b5c…`, Aqua `0x1111113C…`); read them from
`deployments/sepolia.json` at pack time rather than hard-coding twice if a prepare script already
exists (`scripts/subgraph-prepare.ts` is the model).

Map module `map_horizon_events` outputs `HorizonEvents { events: repeated HorizonEvent }` where each
event carries: `kind` (enum: MARKET_CREATED, CURVE_FILLED, ROUTE_EXECUTED, STRATEGY_ADMITTED, SHIPPED,
DOCKED, COLLATERAL_CHANGED, MARKET_RESOLVED), decoded `data` (typed oneof, not JSON), `contract`
(emitting address), `block_number`, `block_hash`, `block_timestamp`, `tx_hash`, `log_index`, `tx_index`.
Filter: `MarketCreated` only from the registry; `CurveFilled`/`StrategyAdmitted` only from the router;
`RouteExecuted` only from the executor; `Shipped`/`Docked` from Aqua only where `app == router`.
`CollateralChanged`/`MarketResolved` come from per-market contracts: add a `store_markets`
(StoreSetIfNotExists keyed by market address, fed by MarketCreated) and take it as input to the map so
only Horizon markets pass — this replaces the Subgraph's dynamic template. Emit every kind; the
consumer decides what to act on.

Provide `deployments/substreams.json` (package hash/version, module name, start block) written by the
pack script, mirroring `deployments/graph.json`.

## 2. Consumer process: `src/stream-consumer.ts` (third process, alongside API and worker)

Scripts: `stream:dev` (`tsx watch --env-file=.env src/stream-consumer.ts`) and `stream`
(`node dist/stream-consumer.js`). Config in `src/config.ts` under `stream`: `STREAM_ENABLED`,
`SUBSTREAMS_ENDPOINT` (e.g. the StreamingFast Sepolia endpoint — verify the hostname in the current
Substreams docs, do not guess), `SUBSTREAMS_API_TOKEN` (JWT; never logged), `SUBSTREAMS_PACKAGE`
(path to `.spkg` or registry ref), `SUBSTREAMS_MODULE=map_horizon_events`, `SUBSTREAMS_START_BLOCK`.
Document all in `.env.example` and `OPERATIONS.md`. On Railway this becomes a new service from the
same repo with start command `npm run stream` (note: migrations are applied via `railway ssh`, not
pre-deploy — see OPERATIONS).

Use `@substreams/node` `streamBlocks` with `createRequest({ startCursor })`. Do NOT request
`finalBlocksOnly`: we process live blocks and handle undo. Handle both message cases:
- `blockScopedData`: decode output, process in ONE Prisma transaction (see §6), persist the cursor in
  the same transaction, then `pg_notify` (NOTIFY is delivered on commit, which is exactly the ordering
  we need — never notify before the write is durable).
- `blockUndoSignal`: revert everything above `lastValidBlock` (see §6), persist `lastValidCursor`.
Reconnect with backoff on stream errors, resuming from the stored cursor. Never treat one confirmation
as finality; keep `finalBlockHeight` from each `blockScopedData` and flip rows to final when passed.

## 3. Data model (one migration, `prisma/migrations/2026MMDD0001_live_stream/`)

The existing `MarketProjection`/`CurveProjection` tables are OWNED BY THE SYNC. `syncMarkets`
deletes any row not in the Graph sweep (`src/trading/projection.ts:150`). The stream must NEVER write
those tables, or a lagging Subgraph will delete a live market. Instead:

- `StreamCheckpoint { id 'horizon_events', cursor, blockNumber, blockHash, finalBlock, updatedAt }`.
- `LiveChange` — the overlay layer: `{ id bigserial, entity ('market'|'curve'|'trade'), key (address /
  orderHash / txHash:logIndex), kind (event kind), payload Json, blockNumber, blockHash, txHash,
  logIndex, final Boolean, retiredAt DateTime?, createdAt }`, `@@unique([txHash, logIndex, entity, key])`
  (idempotent on redelivery), `@@index([entity, key, blockNumber])`, `@@index([blockNumber])`.
- `Trade` — one row per `RouteExecuted`: `{ id = txHash:logIndex, market, taker, recipient, isYes,
  isBuy, shares, usdc, fills, blockNumber, blockHash, txHash, final, revertedAt?, source 'stream'|'graph' }`.
  `CurveFilled` events inside the same tx are NOT trades and NOT volume; they only update curve state.
- `Notification { id, dedupeKey @unique, requestId, position Int?, marketAddress, kind
  ('market.created'), title, body, href, blockNumber?, txHash?, sources String[] ('receipt','stream'),
  readAt?, createdAt }`, `@@index([requestId, createdAt])`. `dedupeKey =
  ${requestId}:${position ?? '-'}:${marketAddress.toLowerCase()}`.
- `LiveEvent { id bigserial, type, topic, payload Json, createdAt }` — SSE replay log (see §5).
- Add `creationId String?` (indexed) to `CreationRequest` and `CreationChild`, set when the row moves
  to CREATING using `creationId(requestId, position)` from `src/creation/onchain.ts`; backfill existing
  rows in the migration (a script under `scripts/` is fine if SQL can't compute keccak). This is how a
  `MarketCreated` event is mapped back to its request without scanning.

## 4. What each event does (consumer side, all inside the block's transaction)

- `MARKET_CREATED`: insert `LiveChange(entity:'market')` with the full event payload so the market is
  listable and its detail page renders immediately (question, rules, evidenceSource, closeAt, resolver,
  tokens, createdAt = block timestamp, collateral 0, result 0). Look up
  `CreationRequest`/`CreationChild` by `creationId`; if found, upsert a `Notification` with the
  dedupeKey above, title "Your market was created", `href=/markets/<address>`, add `'stream'` to
  `sources`. Do NOT say "ready to trade" — that wording is only allowed once executable liquidity
  (active AND admitted curve with remaining > 0) is observed. For a GROUP request update that child's
  `EventMarket.marketAddress` if still null (same lower-casing as `runGroupCreation`); do not wait for
  the whole group. Emit SSE `creation.updated` (private topic `creation:<requestId>`) and
  `market.updated` (public).
- `CURVE_FILLED`: insert `LiveChange(entity:'curve', key: orderHash, payload {filled: totalFilled,
  active: totalFilled < maxShares})`. Emit `liquidity.changed` for the market AND for every other
  market where this maker has active+admitted curves (shared wallet balance/allowance backs all of a
  maker's curves) — read the maker's markets from `CurveProjection` + overlay. Coalesce: buffer
  `liquidity.changed` topics per block and flush once after commit, so a route with 4 fills produces
  one message per affected market, not four. There is no server-side quote cache; do not add one.
  "Expiring a quote" means the UI re-quotes on `liquidity.changed`; the quote itself stays
  RPC-verified at a pinned block exactly as `TradingService.quote` does today — never infer wallet
  balances or allowances from events.
- `ROUTE_EXECUTED`: upsert `Trade` (id = txHash:logIndex), emit `trade.executed` for the market.
- `STRATEGY_ADMITTED`, `SHIPPED`, `DOCKED`, `COLLATERAL_CHANGED`, `MARKET_RESOLVED`: record as
  `LiveChange` so the overlay is complete (admitted/active flags, collateral, result) and emit
  `market.updated` / `liquidity.changed`. Notifications for these are out of scope.

## 5. Read path: overlay on top of the snapshot (the most important backend change)

Add a pure function `applyOverlay(snapshot: IndexedSnapshot, changes: LiveChange[]): IndexedSnapshot`
in `src/trading/overlay.ts` with unit tests. Rules: only changes with `blockNumber > snapshot.block`
apply; a `market` change for an address absent from the snapshot adds it; `curve` changes patch
`filled/active/admitted`; a curve that becomes inactive/exhausted drops out of `curves` (the snapshot
already excludes non-executable depth); changes with `retiredAt` set never apply. The result must be
indistinguishable in shape from a Graph read (same contract as `fromMarketRow`).

Apply it in `MarketService.read` for BOTH branches (projection and Graph fallback), and in
`curvesByMaker`. Add `GET /api/markets/:market/trades` merging Graph `routes` (base, via
`GraphProvider.activity`) with `Trade` rows above the base block, deduped by id; expose it on the
market page as history. Include `liveBlock` next to `indexedBlock` in responses so the UI can show
"as of block N".

Retirement: after each successful `syncMarkets` sweep, mark `retiredAt` on every non-reverted
`LiveChange` with `blockNumber <= indexedBlock` (the snapshot now covers it). Do it inside the sweep's
transaction. Keep the periodic sync unchanged otherwise; it stays the reconciliation mechanism and the
reorg self-healer for the mirror. Add a periodic cleanup of retired rows older than 24h.

## 6. Failure semantics, reorgs, replay

- One transaction per block: `LiveChange` + `Trade` + `Notification` + `EventMarket` patch +
  `StreamCheckpoint` cursor. Then `pg_notify('horizon_live', ...)` — the API process holds a
  dedicated `pg` client with `LISTEN horizon_live` (re-LISTEN on reconnect) and fans out to SSE.
  Write each SSE message to `LiveEvent` first (in the block transaction) so replay is possible.
- Duplicate delivery (same block twice after a restart): every write is an upsert on a natural key
  (txHash+logIndex, dedupeKey, trade id). A replayed block must produce zero new rows and zero new
  notifications. Test this explicitly.
- Restart: resume from `StreamCheckpoint.cursor`; if absent, from `SUBSTREAMS_START_BLOCK`.
- Reorg (`blockUndoSignal(lastValidBlock)`): delete `LiveChange`/`LiveEvent` rows with
  `blockNumber > lastValidBlock`; set `Trade.revertedAt` (keep the row for audit, exclude from
  history); delete `Notification` rows whose `sources` is exactly `['stream']` and `blockNumber >
  lastValidBlock` (a receipt-confirmed one stays). Emit `market.updated` + `trade.reverted` for
  affected markets so open pages correct themselves. Never rely on one confirmation as final; `final`
  flips only when `finalBlockHeight >= blockNumber`.
- Receipt + stream converge on one notification: in `runCreation` (single, `service.ts:814`) and
  `runGroupCreation` (per child, `service.ts:866`) upsert the same `Notification` by `dedupeKey` inside
  the existing transaction, adding `'receipt'` to `sources`, and `pg_notify` after commit. Whichever
  path is first creates it; the second only merges `sources`. The audit outbox (`recordCreation`) is
  the pattern to copy.

## 7. Global SSE and the bottom-of-site notification

Backend: `POST /api/live` returning `text/event-stream` (POST, not GET, so creation tokens travel in
the body — tokens must never appear in a URL). Body: `{ creations: [{ id, token }] }`. Validate every
token with the same constant-time hash check as `CreationService.authorize` and subscribe the
connection to `creation:<id>` for the ones that pass (silently drop the rest — do not reveal which).
Knowing a wallet address grants nothing. Public topics need no auth. Honour `Last-Event-ID` (the
`LiveEvent.id`) by replaying from `LiveEvent`; if the id is older than what is retained, send a
`snapshot.required` event and the client refetches. Send `: keepalive` every 20s. Rate-limit like the
other routes. Message types: `creation.updated`, `market.updated`, `liquidity.changed`,
`trade.executed`, `trade.reverted`, `snapshot.required`; payload always includes `market` (when
relevant), `blockNumber`, `final`.

Frontend: open the stream once in `App.tsx` (fetch + ReadableStream SSE parser, ~40 lines, no new
dependency), survive route changes, reconnect with backoff and `Last-Event-ID`, reopen when the set of
remembered creation tokens changes (`web/src/creations.ts` archive). Provide a `useLive(topic,
handler)` hook; pages refresh only the affected piece: `Markets` re-fetches the list on
`market.updated`; `MarketDetail` re-fetches detail + re-quotes on `liquidity.changed`, appends to
history on `trade.executed`, drops on `trade.reverted`; `CreateMarket` updates the request/child
status on `creation.updated`. No full page reloads. A toast/notice bar at the bottom of the site shows
"Your market was created" with a link to `/markets/<address>`; notifications persist — on load, fetch
them via the already-authorized `GET /api/creation/requests/:id` (add `notifications` to that
response) for each remembered creation, and add `POST /api/creation/requests/:id/notifications/:nid/read`.
Wording: "created" until executable liquidity exists; then the market page may say "ready to trade".

## 8. Tests (all must pass: `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run web:typecheck`)

- `test/overlay.test.ts`: applyOverlay — adds unseen market; patches filled/active; ignores changes at
  or below the snapshot block; ignores retired changes; output shape equals `fromMarketRow` shape.
- `test/stream.test.ts`: event decoding → change rows; notification dedupeKey derivation; liquidity
  topic coalescing (4 fills, 2 makers → expected set of markets, one flush).
- `test/stream.integration.test.ts` (DB): (a) block processed atomically — inject a failure after the
  Trade write and assert nothing (cursor included) was committed; (b) the same block delivered twice
  creates no duplicate rows/notifications; (c) restart resumes from the stored cursor; (d) undo signal
  reverts rows above lastValidBlock and keeps receipt-backed notifications; (e) receipt path first then
  stream, and stream first then receipt, both yield exactly one notification with `sources` =
  ['receipt','stream']; (f) `syncMarkets` with a Graph snapshot that lags the stream does NOT remove the
  live market from reads, and a later sweep at or past the block retires the overlay row while the
  market keeps rendering identically.
- Acceptance (`scripts/verify-live.ts`, documented in OPERATIONS): with `MARKET_SYNC_ENABLED=false`,
  create a market and execute a trade on Sepolia (reuse `scripts/seed-phase2.ts` /
  `verify-phase2-live.ts` helpers); assert via the API that the market lists, the notification exists,
  liquidity reflects the fill and the trade is in history — all before any sync runs. Then re-enable
  sync and assert nothing changes from the reader's perspective. Use recorded Substreams fixtures under
  `test/fixtures/substreams/` for the integration tests so CI needs no network.

## 9. Docs and delivery

Update `docs/ARCHITECTURE.md` (new "Live layer" section: ownership of tables, overlay rule, finality
stance, notification convergence), `OPERATIONS.md` (third process, env vars, Railway service, how to
rebuild/pack the module, what to do when the cursor is lost), `.env.example`, and `README.md` run
instructions. Keep `publicConfig` honest: add `live: { available, finality: 'reorg_aware' }`.

Work in this order and commit after each: (1) migration + models + `creationId` backfill; (2) Rust
module + pack script; (3) consumer with atomic block processing, cursor, undo; (4) overlay + read path
+ trades endpoint; (5) notification convergence in `runCreation`/`runGroupCreation`; (6) SSE server +
LISTEN/NOTIFY; (7) web stream + hook + page updates + toast; (8) tests, docs, acceptance script.
Before step 3, confirm the Sepolia Substreams endpoint and auth flow against the current Substreams
docs and state what you verified. Do not change `syncMarkets` deletion behaviour; the overlay exists
precisely so it doesn't have to change. Report anything you could not verify or complete explicitly.

---

## Verified facts behind this prompt (as of 2026-09-11)

- The mirror deletion is at `src/trading/projection.ts:150-151` (`deleteMany` on curves then markets),
  inside `syncMarkets`'s transaction — the overlay design in §5 is what keeps live rows out of its reach.
- `creationId` is `keccak256("horizon-creation:<requestId>[:<position>]")` (`src/creation/onchain.ts:18`);
  the hash cannot be reversed, so the consumer needs the stored, indexed `creationId` column.
- The quote path (`src/trading/service.ts:17`) already reads candidates from The Graph and re-reads on
  chain at a pinned block with a ≤64-block staleness check, so quotes stay RPC-verified with no change —
  only the SSE trigger is new.
- Creation auth is a per-request bearer token compared by sha256 hash (`src/creation/service.ts:97`),
  stored only in the browser (`web/src/creations.ts`) — hence the POST-body SSE subscription.
- No server-side quote cache exists today; the prompt says not to invent one.
