# Roadmap and product decisions

Horizon was built for ETHOnline 2026 against a four-day budget by one builder with AI assistance.
This file records what was decided, what each phase delivered, and what the project deliberately
does not do. Current public evidence lives in [EVIDENCE.md](EVIDENCE.md); the architecture is
described in [ARCHITECTURE.md](ARCHITECTURE.md).

Required integrations, all four in scope from the start: 1inch Aqua/SwapVM, The Graph, Hedera
x402, and World.

## Product decisions

- **General binary questions** in the first release, not a crypto-only or one-hour-market product.
- **Only USDC is shared across markets.** Outcome tokens must belong to the market and outcome
  addressed by their curve.
- Outcomes are bootstrapped by **matching complementary YES and NO buyers**, rather than requiring
  makers to pre-mint inventory.
- Holders decide whether to sell and publish sell curves explicitly. There is **no automatic
  resale or inventory recycling**.
- Equal start and end prices produce a **fixed-price limit order**; execution still depends on a
  counterparty taking it.
- A few **curve-shape presets**, not continuous alpha control.
- Routing is computed off-chain across multiple curves and settled **atomically on chain**.
- Matching is **trader-triggered**; there is no autonomous background matcher.
- A disclosed **Horizon admin** resolves markets to YES, NO or INVALID using the published rules
  and an evidence reference. INVALID pays 0.50 USDC per outcome token.
- **Both browser users and agents pay their own creation requests** on Hedera; no sponsored path.
- **World verification reduces the creation charge** rather than gating any trading.
- Backend in **TypeScript**, with an ORM, admin tooling and durable background jobs.

## Phase 0 — Integration checks

- [x] Establish the repository and record dependency and source provenance.
- [x] Pin compatible official Aqua/SwapVM sources and test a custom opcode extension with real
      local token transfers and output-first callbacks.
- [x] Verify the deployed Aqua registry and the Horizon router on Sepolia.
- [x] Establish trading-network RPC access, gas and test USDC.
- [x] Confirm Graph Studio access and deploy a live indexing path.
- [ ] Obtain World Selfie Check/Sandbox access.
- [ ] Prove a Blocky402-settled Hedera payment from both an agent and a browser wallet
      (agent complete; browser wallet outstanding).
- [x] Pin the Express/admin/ORM integration and the separate durable-worker setup.

**Exit:** versions and network configuration recorded, signing feasibility demonstrated, World
access status known.

## Phase 1 — Market lifecycle and first match

- [x] Market registry/factory, ERC-20 outcomes, collateral escrow, closing, resolution, redemption.
- [x] Fix question, rules, evidence source, deadline and resolver before trading starts.
- [x] One flat-price Horizon SwapVM strategy with market and token validation.
- [x] Output-first settlement with an authenticated callback for complementary minting.
- [x] A YES buyer contributing 0.60 USDC and a NO buyer contributing 0.40 USDC mint a backed pair.
- [x] Emit the market, strategy, fill, collateral and resolution events needed for indexing.

**Exit:** one transaction transfers both contributions, locks the collateral and delivers both
outcomes; a later resolution permits correct redemption.

Coverage includes both complementary directions, YES/NO/INVALID payouts, persistent flat-price
partial fills, wrong tokens and markets, authorization and callback rejection, cancellation,
shared-wallet depletion, and rollback when the final Aqua transfer fails after minting. Run
`npm run contracts:demo` for the traced 0.60/0.40 match and redemption.

## Phase 2 — Curves, routing and live indexing

- [x] Curve presets, partial-fill accounting, size and budget limits, cancellation.
- [x] Direct outcome trades and complementary minting as alternative buy-route legs.
- [x] A bounded multi-fill executor and off-chain allocator with a four-fill cap.
- [x] Joint accounting for curves backed by the same maker wallet and token.
- [x] Deploy the Subgraph; candidate discovery, bounded RPC refresh, complete-route simulation.
- [x] Expose quotes with amounts, chosen fills, snapshot information, limits, deadline, calldata.
- [x] USDC shared across two markets, where a fill reduces executable capacity elsewhere.

**Exit:** a live quote fills at least two curves atomically; stale state, exhausted balances and
slippage produce safe rejection or requoting. The allocator is a bounded search, not a
global-optimality guarantee. Details and arithmetic: [../PHASE2.md](../PHASE2.md).

## Phase 3 — Creation service and application

- [x] Market browsing, market detail and trading, curve publication, holdings, admin resolution.
- [x] AI drafting grounded on live Graph data, with duplicate and overlap warnings.
- [x] Requester review of the draft before paying.
- [x] Creation gated through Hedera x402 and Blocky402 for agent clients.
- [ ] The same gate proven from a browser wallet (client implemented, nothing settled yet).
- [ ] World credentials verified server-side before payment requirements are issued
      (implemented and tested; access still pending).
- [x] Persist request, payment and discount state; make a paid request resumable without
      double charging.
- [x] Authenticated admin views, explicit retry and resolution actions, durable service jobs.
- [ ] Public HTTPS hosting of the frontend and API.

**Exit:** a browser user and an agent each complete a paid creation, a qualifying World credential
changes the charged amount, and the resulting market appears through live indexing. **Partially
met:** the agent path is complete and indexed.

## Phase 4 — Verification and submission

- [x] Contract, arithmetic, routing, payment and browser-flow checks.
- [x] Verify public deployment addresses and document the centralized creation and resolution roles.
- [x] Sponsor evidence; [WORLD_FEEDBACK.md](WORLD_FEEDBACK.md) is written with its Sandbox
      sections left blank until a credential is granted.
- [ ] Record a demo using actual transactions and live indexed data.

## Events and imported definitions

Added after Phase 4. An **event** groups several independent binary markets — "Barcelona wins",
"Real Madrid wins", "Draw" — under one title, one review and one payment. Every child keeps its own
market contract, collateral, trading and resolution; standalone markets and their URLs are
unchanged. Membership says nothing about the outcomes unless the event is marked exclusive, and
even then the "exactly one winner" rule is enforced by Horizon's resolution workflow only: the
market contracts hold no notion of a group. Shared collateral and negative-risk conversion between
siblings are deliberately **not implemented**.

Events can be authored on Horizon or imported from a Polymarket event or market page. An import
copies **definitions only**, through the backend, from a fixed API origin that a request can never
choose. Source prices, liquidity, volume and settlement never become Horizon data, and settlement
is never delegated. A preview shows exactly what would be created, and what is refused and why,
before anything is approved or charged. A group is priced per market at the standalone price, and
approval binds to the whole plan, so changing the selection reprices it and invalidates the
approval.

## Acceptance checks

- Every minted YES/NO pair is backed by one USDC; unauthorized minting and double redemption fail.
- Wrong USDC addresses, unrelated outcome tokens, expired markets and cancelled strategies cannot
  execute.
- Flat and shaped curves agree across contract and off-chain arithmetic, including partial fills
  and rounding.
- A shared maker balance is not counted independently for every fill; balance and allowance changes
  invalidate affected routes.
- Direct, complementary and mixed buy routes settle atomically; forged callbacks or failed legs
  revert all effects.
- Spending limits, output limits and deadlines are enforced on chain.
- Receiving outcomes never creates a sell authorization by itself.
- Within one market, a maker's resting orders cannot commit more of a funding token than the wallet
  can currently spend, and the refusal is on chain rather than in the UI. USDC stays shared across
  markets.
- Payment retries do not double-charge or create duplicate markets; failed creation remains
  recoverable after settlement.
- Replayed verification cannot repeatedly redeem the same discount entitlement.
- YES, NO and INVALID payouts conserve collateral, including documented dust handling.
- Zero maker, taker, routing and protocol trading fees are reflected in both contracts and UI.

## Out of scope

Autonomous matchers, automatic resale, continuous alpha control, routes spanning different markets,
complementary sell-and-merge execution, decentralized disputes, mainnet rollout and broad analytics
are outside this baseline. Order budgets are per market by design: nothing reserves funds globally,
no order is deactivated automatically when a wallet is drained, and two markets racing for the same
balance is not solved here. None of the four required sponsor integrations may be dropped to make
room for these.
