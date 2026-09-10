# Phase 2 implementation and live evidence

Verified September 9, 2026 (local time). The Phase 2 exit is complete: a live Graph-backed quote selected two curves, simulated the full transaction, and executed both fills atomically on Sepolia. All trading fees remain zero.

## Public deployment

- Registry: `0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1`
- HorizonSwapVM: `0x2b7592171cc7cfaa21dd60b49c81d68cf584302d` (redeployed September 10, 2026 for per-market order budgets)
- OrderBudget: `0x563D51c62260F484C5765712fd9716704cF266A2` (deployed and owned by the router)
- RouteExecutor: `0x657b5cf110bed745c5b3f33c77d61855abb4cfa9`
- Superseded by that redeployment, kept for reference: HorizonSwapVM `0xf155c2ad43d020b601ee51a7e086112a5d00240f`, RouteExecutor `0xede6eea88b6701e1c40dab0a9bba1cb8890e5bd4`. The registry is unchanged, so markets created before it still exist; orders published to the old router stay there and are not migrated.
- Official AquaRouter: `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`
- Circle Sepolia USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- [Live Subgraph query endpoint](https://api.studio.thegraph.com/query/1758973/horizon/0.3.1), Studio version `0.3.1`. This is a working Studio deployment, not a claim of decentralized-network publication.
- [Atomic two-curve transaction](https://sepolia.etherscan.io/tx/0xe59d75c5dc159603433faa068a7cd6bd62e1f09fb8b273705040c349f1557aba).

The configured Aqua deployment is `AquaRouter`, which wraps `Aqua` with upstream simulation, multicall, and rescue functions. Sourcify reports an exact runtime match. Its Aqua core, IAqua interface, and Balance library match the vendored source byte for byte. Its different compiler settings and wrapper explain why comparison against our locally compiled bare Aqua did not match. [Aqua verification](deployments/aqua-verification.json) records the source provenance and observed runtime hash.

Public, machine-readable evidence:

- [Deployment addresses and transactions](deployments/sepolia.json).
- [Demo markets, maker/taker, strategy parameters, and publication transactions](deployments/phase2-demo.json).
- [Exact quotes, calldata, simulation snapshots, trade receipt reference, and shared-wallet checks](deployments/phase2-evidence.json).
- [Live Graph result for the route, both fills, collateral, and exhausted strategies](deployments/phase2-indexed.json).

The demo uses distinct maker and taker wallets. The maker initially received **1 test USDC** and published three curves across two markets. The executed route acquired **2 YES**, escrowed **2 USDC**, and consumed **0.816666 maker USDC** plus **1.183334 taker USDC**. The maker retained **0.183334 USDC**, making the previously simulated one-share purchase in the other market unavailable. Replaying the old transaction calldata was rejected. Graph indexed one route, two fills, the correct collateral, and both consumed curves as inactive.

## Contract interfaces and arithmetic

Phase 1's `0xf0` flat BUY instruction and single-order executor source remain compatible. Phase 2 uses `0xf1` with `CurveStrategy`:

```text
market      address
flags       uint8: YES bit 0; BUY bit 1; shape (1, 2, 3) in bits 2..3
startPrice  uint32: micro-USDC per whole outcome
endPrice    uint32
maxShares   uint64: outcome base units, capped at 1e15
salt        bytes32
```

BUY prices decline; SELL prices rise. Equal endpoints are fixed-price limit orders. Both endpoints must lie strictly between zero and one USDC. All tokens use six decimals. The preset function is `p(x) = start + (end - start) * x^shape`.

`CurveMath` evaluates the rational cumulative integral exactly with integer numerator/denominator arithmetic. BUY cumulative cost rounds down; SELL cumulative cost rounds up. Fill cost is the difference between cumulative endpoints. A `1e15` base-unit size cap keeps intermediates below `4e66`, within `uint256`. Splitting cannot change total cumulative cost. Each executed leg must have positive USDC and complementary contributions; tiny unrepresentable fills revert. The quote search aggregates its chunks into valid on-chain legs and expands its search chunk when extreme prices require a larger representable quantity.

Publish through `buildCurveOrder(maker, strategy)` and `Aqua.ship(router, abi.encode(order), [outcome, USDC], amounts)`, then `HorizonSwapVM.admitCurve(strategy)`. A BUY starts with zero outcome allocation and a USDC budget. A SELL starts with an outcome allocation and zero USDC allocation. Approve the asset being sold to Aqua. `maxShares` and Aqua's actual output allocation jointly bound execution. `Aqua.dock` cancels all tokens for an order; changing terms requires a fresh order/salt.

Shipping alone does not publish an order to Horizon. `Aqua.ship` has no application callback, so anyone can record a strategy naming this router; the router therefore requires the second step and refuses to fill any order it has not admitted. Admission records the order's remaining obligation in `OrderBudget` — the exact curve integral for a BUY, undelivered shares for a SELL — and refuses it if this market's existing commitments for the same funding token plus this one would exceed `min(balance, allowance to Aqua)`. USDC stays shared across markets; only orders **within one market** are added together, and buying either outcome draws on the same USDC budget while each outcome token is its own inventory. Each fill subtracts exactly what it spent, cancellation and exhaustion release the rest, and no funds are reserved. A shipped-but-unadmitted order is inert: it commits nothing, is excluded from discovery and quoting, and can be docked to recover the allocation. Read `router.budget()` for the ledger address; the router deploys it, so nothing configures it. The full rule is in `docs/ARCHITECTURE.md`.

The instruction reconstructs the entire canonical order and validates its hash, tokens, market, direction, open status, price bounds, and fill capacity. Only USDC can cross market strategies; outcomes always belong to the exact registered market. `decodeCurveOrder` lets the indexer validate publication bytes through the deployed contract. Receiving outcomes never creates a SELL authorization.

`RouteExecutor.execute(request, legs)` takes an exact-share request and at most four fills in one market. Buy routes may combine direct SELL curves for the requested outcome with opposite BUY curves that mint complementary pairs. Sell routes deliver existing outcomes to matching BUY curves. Each leg carries `expectedFilled`; state changes require requoting. Duplicate legs, if submitted manually, must use the correct sequential fill counters.

The request specifies market, YES/NO, buy/sell, shares, USDC limit, recipient, and deadline. For buys, the executor pulls the maximum USDC, spends the required total, and refunds the difference. For sells, it pulls exact outcomes and checks minimum USDC proceeds. Authenticated callbacks mint only after both complementary contributions are available. A failed leg reverts the whole route. Temporary allowances are cleared, pre-existing donations are preserved, and no trade fees are retained.

## Quote and indexing service

`GET /api/markets` returns live Graph market data and indexing metadata.

`POST /api/quotes` accepts:

```json
{
  "market": "0x...",
  "account": "0x...",
  "recipient": "0x...",
  "isYes": true,
  "isBuy": true,
  "shares": "2000000",
  "slippageBps": 50
}
```

Addresses must be real 20-byte hex addresses. Quantities are decimal strings, never floating-point values. The API currently accepts requests from one whole share through `1e15` base units, and slippage from 0–1000 basis points. The placeholder example above is explanatory, not executable.

The service discovers at most 32 active strategies through Graph, then reads canonical orders, fill counters, Aqua allocations, wallet balances, allowances, and market status at one RPC block. It rejects Graph indexing errors, snapshots lagging over 64 blocks, and inconsistent/reorged block hashes. Shared output balances/allowances are keyed by maker and token across candidate curves. Incoming proceeds are conservatively not recycled into later route capacity.

The allocator performs a bounded chunk search, selecting at most four unique curves. It computes exact amounts for the selected route but **does not promise a globally optimal route**. Candidate truncation, the four-fill cap, chunking, and the conservative funding policy can exclude executable alternatives. Insufficient capacity or exhausted search returns an unavailable quote, never an invented partial fill.

The response includes chosen legs, exact amounts, spending/output limit, 120-second deadline, approvals, zero-fee fields, chain and indexed snapshots, and transaction calldata. Simulation status is one of:

- `passed`: the complete route passed EVM simulation for this account and block.
- `approval_required`: sufficient balance exists, but the required allowance is missing; approve and request a new quote.
- `insufficient_balance`: the account cannot currently fund the route.

The service never claims simulation success from math alone. Current state can change after simulation; contract fill counters, deadlines, limits, and atomic rollback remain authoritative. Quote HTTP requests are rate-limited and at most two refresh operations run concurrently per API process. The API signs no user trades.

The Subgraph indexes fixed market rules, registered token addresses, strategies, fills, routes, collateral, and resolution. It validates Aqua publications against the canonical router instead of trusting arbitrary `Shipped` bytes. Expiration is derived from the fixed timestamp even without a `MarketClosed` transaction. Dynamic market templates track collateral and resolution. Outcome-holder indexing and frontend positions can be added during Phase 3.

## Run and verify

Use Node 24 and Foundry on PATH. The local `.env` now contains the deployed addresses and Graph query URL.

```sh
npm run db:up
npm run dev
```

Browse `http://127.0.0.1:3001/api/markets`. Admin inspection remains at `/admin`. There is no trading frontend yet.

```sh
npm test
npm run contracts:test
npm run test:routes
npm run test:integration
npm run subgraph:prepare
npm run subgraph:codegen
npm run subgraph:build
npm run demo:indexed
```

Verified: **39 Foundry tests**, including three 256-case fuzz properties; **8 TypeScript unit tests**; **3 Docker PostgreSQL/admin/worker integration tests**; and **1 isolated Anvil integration test** with 44 on-chain/TypeScript integral comparisons, whole-route simulation, execution, exhaustion, and reorg checks. Typecheck, production build, and Subgraph build pass. Remote CI is configured but has not run.

Deployment commands (`deploy:phase2`, `subgraph:deploy`, `demo:seed`, `demo:live`) are explicit writes. Contract deployment records pending nonces/transactions before continuing; reconcile an ambiguous attempt rather than deleting its record and retrying. The demo scripts persist receipts and suppress repeat funding/trading after completion. The existing demo's two filled curves are exhausted; replay is expected to fail. Read-only `demo:indexed` can be rerun.

## Next phase

Phase 3 adds the React application, curve publication controls, holdings, admin resolution actions, AI-assisted creation grounded in Graph data, resumable Hedera x402 payments for browsers and agents, and World verification/discounts. The Graph data path is live, but the Graph prize's substantive AI use still needs that Phase 3 creation integration. All four sponsors remain required. World Selfie Check access is still unknown; existing local credentials should be checked before requesting new values.
