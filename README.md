# Horizon

A prediction market where users and agents publish executable pricing curves, reuse available USDC across markets through 1inch Aqua, and create fully backed outcomes by matching complementary buyers.

**Trading fees: 0%. No maker, taker, routing, or Horizon protocol trading fee.** Network gas is separate. The working product design retains a separate x402 market-creation service charge; its final amount has not been confirmed.

## Start here in a new task

Read this roadmap and [PROJECT_BRIEF.md](/Users/xana/work/ethglobal2026/horizon/PROJECT_BRIEF.md) before proposing changes or implementing a phase. The brief explains the product, economic model, sponsor fit, technical boundaries, and decisions from the planning conversation.

- Project directory: `/Users/xana/work/ethglobal2026/horizon`.
- Event: **ETHOnline 2026**, confirmed by the user.
- Build capacity: **one human builder with AI assistance**.
- Original time budget: **four days**, stated on September 8, 2026. Reassess remaining time when continuing; a new task does not restart the clock.
- Required integrations: **1inch Aqua/SwapVM, The Graph, Hedera x402, and World**. All four are required, not optional stretch goals.
- Current status, September 8, 2026: **planning and documentation only**. The folder was empty before these two documents were added. Horizon has no application code, deployed contracts, configured integrations, or passing tests yet.
- Initial milestone: Phase 0 integration checks, followed by the flat-price complementary-match contract proof.

Useful continuation prompt:

> Read /Users/xana/work/ethglobal2026/horizon/README.md and /Users/xana/work/ethglobal2026/horizon/PROJECT_BRIEF.md. Continue Horizon from this context rather than restarting product discovery. Preserve the confirmed choices, inspect the actual implementation state, and work on the phase I request. The user has selected a TypeScript backend; do not reopen the Django-versus-TypeScript decision. Distinguish that confirmed choice from supporting-library recommendations, and verify package compatibility before scaffolding. Keep these documents updated with completed work and evidence.

## Confirmed product choices

- Build **Horizon as a separate project**. The neighboring ArcBook project is from an earlier event and may inform the design; it is not the Horizon codebase.
- Support **general binary questions** in the first release. Earlier crypto-only and one-hour-market suggestions were not selected.
- Only **USDC is shared across different markets**. Outcome tokens must belong to the market and outcome addressed by their curve.
- Bootstrap outcomes by **matching complementary YES and NO buyers**, rather than requiring makers to pre-mint initial inventory.
- Users decide whether to sell acquired outcomes and explicitly publish sell curves. There is **no automatic resale or inventory recycling**.
- Equal start and end prices produce a **fixed-price limit order**. Execution is still conditional on a counterparty taking it.
- Support a few **curve-shape presets** in the MVP, not continuous alpha control.
- Route trades across multiple curves off-chain and settle the selected fills **atomically on-chain**.
- Matching is **trader-triggered**. There is no autonomous background matcher in the first release.
- A disclosed **Horizon admin** resolves markets to YES, NO, or INVALID using the published rules and an evidence reference. INVALID pays 0.50 USDC per outcome token.
- Both **browser users and agents pay their own creation-service requests on Hedera**. A sponsored-browser-only demo was offered and not selected.
- World verification reduces the creation-service charge. World Selfie Check/Sandbox access is currently **unknown**.

## Stack decision: TypeScript backend confirmed

The user initially considered Django and has now **selected TypeScript for the backend**. Their follow-up concern was preserving convenient admin tooling, an ORM, and Celery-style background tasks. All three can be provided within the TypeScript stack.

Working stack recommendations; exact libraries and versions still require integration checks:

- Contracts: Solidity with Foundry, extending pinned official Aqua/SwapVM sources.
- Frontend: React, Vite, TypeScript, wagmi/viem, plus a Hedera-native wallet integration for payments.
- Backend: Node.js, Express, TypeScript.
- Persistence/ORM: PostgreSQL with Prisma for creation requests, payment state, and discount usage.
- Admin: AdminJS with an Express plugin and compatible Prisma adapter; authenticated workflow records and explicit administrative actions.
- Background jobs: pg-boss, using PostgreSQL, with a worker process from the same backend project for creation, reconciliation, and retries.
- Indexing: a deployed Subgraph consumed through a live Graph provider.
- Networks: Ethereum Sepolia for trading and Hedera testnet for service payments.

TypeScript is the confirmed language choice; Express, Prisma, AdminJS, and pg-boss are the recommended supporting tools, not installed or tested components. Pin a compatible AdminJS/Prisma combination rather than assuming their newest versions work together. Plan a persistent Node worker runtime alongside the API; deployment hosting and credentials remain to be established. Background service jobs do not introduce an autonomous trading matcher.

## Four-day roadmap

This is an aggressive dependency-ordered schedule, not evidence that any phase is complete. Keep one backend and one frontend, use testnet assets, and reserve the final half-day for release work.

### Phase 0 — Integration checks: Day 1 opening

- [ ] Establish the Horizon repository and record dependency/source provenance with normal incremental commits.
- [ ] Pin compatible official Aqua/SwapVM sources; verify the chosen deployed Aqua registry and custom-router integration path.
- [ ] Establish trading-network RPC access, gas, and test USDC.
- [ ] Confirm Graph Studio access and deploy a minimal live indexing path as soon as there are relevant events.
- [ ] Check the World developer app and request Selfie Check/Sandbox access if necessary.
- [ ] Prove a small Blocky402-settled Hedera payment from an agent and from a browser wallet.
- [x] Record the user's TypeScript backend selection.
- [ ] Verify the Express/admin/ORM integration and durable-worker setup before pinning package versions.

**Exit:** versions and network configuration are recorded, browser/agent signing feasibility is demonstrated, and World access status is known. An unresolved external dependency remains visible while independent work proceeds.

### Phase 1 — Market lifecycle and first match: Day 1 remainder

- [ ] Implement a market registry/factory, ERC-20 outcomes, collateral escrow, closing, resolution, and redemption.
- [ ] Fix the question, rules, evidence source, deadline, and resolver before trading starts.
- [ ] Implement one flat-price Horizon SwapVM strategy with market/token validation.
- [ ] Prove output-first settlement and an authenticated callback for complementary minting.
- [ ] Demonstrate a YES buyer contributing 0.60 USDC and a NO buyer contributing 0.40 USDC to mint a fully backed pair.
- [ ] Emit the market, strategy, fill, collateral, and resolution events needed for indexing.

**Exit:** one transaction transfers both contributions, locks the collateral, and delivers both outcomes; a later resolution permits correct redemption.

### Phase 2 — Curves, routing, and live indexing: Day 2

- [ ] Implement the planned curve presets, partial-fill accounting, size/budget limits, and cancellation.
- [ ] Add direct outcome trades and complementary minting as alternative buy-route legs.
- [ ] Add a bounded multi-fill executor and off-chain allocator; the proposed initial cap is four fills per route.
- [ ] Account jointly for curves backed by the same maker wallet and token.
- [ ] Deploy the live Subgraph and implement candidate discovery, bounded RPC refresh, and complete-route simulation.
- [ ] Expose quote results with amounts, chosen fills, snapshot information, limits, deadline, and calldata.
- [ ] Demonstrate USDC shared across two markets, with a fill reducing remaining executable capacity elsewhere.

**Exit:** a live quote fills at least two curves atomically; stale state, exhausted balances, and slippage produce safe rejection/requoting.

### Phase 3 — Creation service and application: Day 3

- [ ] Build market browsing, a market detail/trading screen, curve publication, holdings, and an admin resolution flow.
- [ ] Make AI drafting query live Graph data, explain duplicate/overlapping markets, and produce explicit resolution rules.
- [ ] Let the requester review the draft before paying for creation.
- [ ] Gate creation through Hedera x402 and Blocky402 for both browser and agent clients.
- [ ] Verify World credentials server-side and compute eligibility before issuing payment requirements.
- [ ] Persist request/payment/discount state; make a paid creation request resumable without double charging.
- [ ] Add authenticated admin views and explicit retry/resolution actions; run durable service jobs in the backend worker.
- [ ] Publish the frontend and API over HTTPS and consume the deployed Graph provider.

**Exit:** a browser user and an agent each complete a paid creation request; a qualifying World credential changes the charged amount; the resulting market appears through live indexing.

### Phase 4 — Verification and submission: Day 4

- [ ] Run contract, arithmetic, routing, payment, and browser-flow checks.
- [ ] Verify public deployment addresses and document centralized creation/resolution roles.
- [ ] Finish the World feedback document and sponsor-specific evidence.
- [ ] Record a three-to-four-minute demo using actual transactions and live indexed data.
- [ ] Reserve the final half-day for fixes, deployment checks, documentation, and submission.

**Exit:** public repository, working application/API, contract/payment transaction evidence, Graph endpoint, World feedback, and demo video are ready. Prize eligibility is assessed against the actual implementation, not this plan.

## Acceptance checks

- Every minted YES/NO pair is backed by one USDC; unauthorized minting and double redemption fail.
- Wrong USDC addresses, unrelated outcome tokens, expired markets, and cancelled strategies cannot execute.
- Flat and shaped curves agree across contract and off-chain arithmetic, including partial fills and rounding.
- A shared maker balance is not counted independently for every fill; balance/allowance changes invalidate affected routes.
- Direct, complementary, and mixed buy routes settle atomically; forged callbacks or failed legs revert all effects.
- User spending/output limits and deadlines are enforced on-chain.
- Receiving outcomes never creates a sell authorization by itself.
- Payment retries do not double-charge or create duplicate markets; failed creation remains recoverable after settlement.
- Replayed verification cannot repeatedly redeem the same discount entitlement.
- YES, NO, and INVALID payouts conserve collateral, including documented dust handling.
- Zero maker, taker, routing, and Horizon protocol trading fees are reflected in both contracts and UI.

## Deferred features

Autonomous matchers, automatic resale, continuous alpha control, routes spanning different markets, complementary sell-and-merge execution, decentralized disputes, mainnet rollout, and broad analytics are outside the four-day baseline. Do not silently remove one of the four required sponsor integrations to add these features.

## Updating the handoff

Check off work only after verifying the exit criterion. Record real commit IDs, test commands/results, deployment addresses, endpoints, and remaining blockers as they become available. Keep secrets out of these files. If implementation or user decisions change, update both the roadmap and the relevant brief section.

The detailed economic examples, sponsor links, proposed API boundaries, and unresolved implementation questions are in [PROJECT_BRIEF.md](/Users/xana/work/ethglobal2026/horizon/PROJECT_BRIEF.md).
