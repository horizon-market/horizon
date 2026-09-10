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
- Current status, September 9, 2026: **Phase 3 is complete apart from two credential-blocked flows, and Phase 4 verification and documentation are done**. On top of the live Phase 2 trading stack, an agent-owned client completed a real paid creation: 1 HBAR settled on Hedera testnet through Blocky402, a market was created on Sepolia under a creation id derived from its request id, and The Graph indexed it. The React application, the resumable creation workflow, and the operator screen all run against the live API. See [PHASE2.md](PHASE2.md) for the trading contracts and arithmetic, and [docs/EVIDENCE.md](docs/EVIDENCE.md) for the verified addresses, transactions and disclosed roles.
- Next milestone: **close the four outstanding items and submit**. A browser-wallet Hedera payment (the WalletConnect client renders live requirements but has settled nothing yet), a World Selfie Check verification (fully implemented; `WORLD_SELFIE_ACCESS` is still `unknown`, so no credential has ever been verified and no discount granted), public HTTPS hosting, and the demo recording. A hosted-model drafting credential is also unconfigured, so the deterministic provider runs; it is grounded on the same live Graph data and labelled `development`.
- Setup, test evidence, current limitations, and pending access: [OPERATIONS.md](OPERATIONS.md). Protocol source provenance: [contracts/README.md](contracts/README.md).

Useful continuation prompt:

> Read /Users/xana/work/ethglobal2026/horizon/README.md, PROJECT_BRIEF.md, OPERATIONS.md, PHASE2.md, and contracts/README.md. Continue Horizon from this context rather than restarting product discovery. Phase 2 is live on Sepolia with a deployed Subgraph, exact integer curve math, atomic routes, and a Graph-backed quote API. Continue Phase 3: React trading/creation UI, Graph-grounded AI, browser and agent Hedera x402 payments, World verification/discounts, and admin resolution. Preserve zero trading fees, USDC-only sharing, market-specific outcomes, and explicit resale authorization. Read deployments/*.json for public transaction evidence and check existing local credentials without printing them.

## Events: grouped markets and imported definitions

Added after Phase 4. An **event** groups several independent binary markets — "Barcelona wins",
"Real Madrid wins", "Draw" — under one title, one review and one payment. Every child keeps its own
market contract, collateral, trading and resolution; standalone markets and their URLs are
unchanged. Being in an event says nothing about the outcomes unless the event is marked as
exclusive, and even then the "exactly one winner" rule is checked by Horizon's resolution workflow
only — the market contracts hold no notion of a group. Shared collateral and negative-risk token
conversion between siblings are deliberately **not implemented**.

Events can be authored on Horizon or imported from a Polymarket event or market page. An import
copies **definitions only** — question, outcome labels and order, resolution criteria, evidence
source and dates — through the backend from a fixed Polymarket API origin. Source prices,
liquidity, volume and settlement never become Horizon data, and settlement is never delegated:
the disclosed Horizon resolver still decides. A preview shows exactly what would be created, and
what is refused and why, before anything is approved or charged. A group is priced per market at
the standalone price, and approval binds to the whole plan, so changing the selection reprices it
and invalidates the approval.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the model, the import rules and the
enforcement boundary, and [OPERATIONS.md](OPERATIONS.md) for the migration and settings.

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

Implemented backend and contract foundation, with the frontend/indexing stack still planned:

- Contracts: Solidity with Foundry, extending pinned official Aqua/SwapVM sources.
- Frontend: React, Vite, TypeScript, wagmi/viem, plus a Hedera-native wallet integration for payments.
- Backend: Node 24.10.0, Express 4.22.2, TypeScript 5.9.3.
- Persistence/ORM: Docker PostgreSQL with Prisma 6.19.3; draft request metadata, diagnostic jobs, and admin sessions are implemented. Payment/discount state comes later.
- Admin: AdminJS 7.8.17, Express adapter 6.1.1, Prisma adapter 5.0.4; authenticated record inspection works. Deliberate administrative actions are later work.
- Background jobs: pg-boss 10.4.2 with a separate worker process. Durable diagnostic jobs, retries, and duplicate-effect prevention are tested; real service handlers come later.
- Indexing: a deployed Subgraph consumed through a live Graph provider.
- Networks: Ethereum Sepolia for trading and Hedera testnet for service payments.

TypeScript is the confirmed language choice. The selected supporting libraries are now installed, pinned, and locally tested. See OPERATIONS.md for dependency advisories to resolve or assess before public admin exposure. Hosting and external credentials remain to be established. Background service jobs do not introduce an autonomous trading matcher.

## Four-day roadmap

This is an aggressive dependency-ordered schedule, not evidence that any phase is complete. Keep one backend and one frontend, use testnet assets, and reserve the final half-day for release work.

### Phase 0 — Integration checks: Day 1 opening

- [x] Establish the Horizon repository and record dependency/source provenance with normal incremental commits.
- [x] Pin compatible official Aqua/SwapVM sources and test a custom opcode extension with actual local token transfers and output-first callbacks.
- [x] Verify the chosen deployed Aqua registry and the eventual Horizon router on Sepolia (Sourcify exact runtime/core-source match; Horizon deployment wiring and live transfers verified).
- [x] Establish trading-network RPC access, gas, and test USDC (read-only doctor checks confirmed Sepolia and positive deployer balances; no deployment gas estimate yet).
- [x] Confirm Graph Studio access and deploy a live indexing path for market/strategy/fill/collateral/resolution events.
- [ ] Check the World developer app and request Selfie Check/Sandbox access if necessary.
- [ ] Prove a small Blocky402-settled Hedera payment from an agent and from a browser wallet.
- [x] Record the user's TypeScript backend selection.
- [x] Verify and pin the Express/admin/ORM integration and separate durable-worker setup.

**Local evidence:** TypeScript build/typecheck, two unit tests, three PostgreSQL integration tests, three Foundry tests, matching database migration/schema, and 329 verified vendor file hashes. Admin login renders in a browser. `npm run doctor` confirms advertised Blocky402 Hedera testnet v2 capability and reports the outstanding live checks as pending. CI is configured but has not run remotely.

**Exit:** versions and network configuration are recorded, browser/agent signing feasibility is demonstrated, and World access status is known. An unresolved external dependency remains visible while independent work proceeds.

### Phase 1 — Market lifecycle and first match: Day 1 remainder

- [x] Implement a market registry/factory, ERC-20 outcomes, collateral escrow, closing, resolution, and redemption.
- [x] Fix the question, rules, evidence source, deadline, and resolver before trading starts.
- [x] Implement one flat-price Horizon SwapVM strategy with market/token validation.
- [x] Prove output-first settlement and an authenticated callback for complementary minting.
- [x] Demonstrate a YES buyer contributing 0.60 USDC and a NO buyer contributing 0.40 USDC to mint a fully backed pair.
- [x] Emit the market, strategy, fill, collateral, and resolution events needed for indexing (Aqua supplies strategy ship/dock events).

**Exit:** one transaction transfers both contributions, locks the collateral, and delivers both outcomes; a later resolution permits correct redemption.

**Evidence, September 9:** 33 Foundry tests pass, including two fuzz properties with 256 cases each. Tests cover both complementary directions, YES/NO/INVALID payouts, persistent flat-price partial fills, wrong tokens/markets, authorization and callback rejection, cancellation, shared-wallet depletion, and rollback even when the final Aqua transfer fails after minting. Run `npm run contracts:demo` for the traced 0.60/0.40 match and redemption, or `npm run contracts:test` for the suite. Both run locally without credentials or testnet spending. [Contract details and integration instructions](contracts/README.md) describe units, rounding, ABI entry points, event discovery, and remaining work.

### Phase 2 — Curves, routing, and live indexing: Day 2

- [x] Implement curve presets 1/2/3, partial-fill accounting, size/budget limits, and cancellation.
- [x] Add direct outcome trades and complementary minting as alternative buy-route legs.
- [x] Add a bounded multi-fill executor and off-chain allocator with a four-fill cap.
- [x] Account jointly for curves backed by the same maker wallet and token.
- [x] Deploy the live Subgraph and implement candidate discovery, bounded RPC refresh, and complete-route simulation.
- [x] Expose quote results with amounts, chosen fills, snapshot information, limits, deadline, and calldata.
- [x] Demonstrate USDC shared across two markets, with a fill reducing remaining executable capacity elsewhere.

**Exit:** a live quote fills at least two curves atomically; stale state, exhausted balances, and slippage produce safe rejection/requoting.

**Evidence:** [live two-fill transaction](https://sepolia.etherscan.io/tx/0xe59d75c5dc159603433faa068a7cd6bd62e1f09fb8b273705040c349f1557aba), [Graph-indexed result](deployments/phase2-indexed.json), and [complete handoff](PHASE2.md). Local checks: 39 Foundry tests, 8 TypeScript unit tests, 3 PostgreSQL integration tests, and an Anvil end-to-end test with 44 contract/TypeScript pricing comparisons. The allocator is a bounded search, not a global-optimality guarantee. Unfunded or unapproved requests explicitly remain unsimulated until ready.

### Phase 3 — Creation service and application: Day 3

- [x] Build market browsing, a market detail/trading screen, curve publication, holdings, and an admin resolution flow.
- [x] Make AI drafting query live Graph data, explain duplicate/overlapping markets, and produce explicit resolution rules (grounded drafting and duplicate warnings run against the live Subgraph; the hosted-model provider is implemented but unexercised, so the deterministic provider runs and is labelled `development`).
- [x] Let the requester review the draft before paying for creation.
- [x] Gate creation through Hedera x402 and Blocky402 for both browser and agent clients (the agent client settled a real payment; the browser WalletConnect client renders live requirements but has not settled one yet).
- [ ] Verify World credentials server-side and compute eligibility before issuing payment requirements (implemented and unit-tested end to end; `WORLD_SELFIE_ACCESS` is still `unknown`, so no credential has ever been verified).
- [x] Persist request/payment/discount state; make a paid creation request resumable without double charging.
- [x] Add authenticated admin views and explicit retry/resolution actions; run durable service jobs in the backend worker.
- [ ] Publish the frontend and API over HTTPS and consume the deployed Graph provider (the app runs locally against the live Graph provider; no public hosting yet).

**Exit:** a browser user and an agent each complete a paid creation request; a qualifying World credential changes the charged amount; the resulting market appears through live indexing. **Partially met:** the agent path is complete and indexed; the browser payment and the World credential are outstanding.

**Evidence, September 9:** an agent-owned client completed a real paid creation — 1 HBAR settled on Hedera testnet through Blocky402, market `0xBC11a878771E75a1C32bfB23A0B40db704F27432` created on Sepolia in block 11667797 under a creation id derived from its request id, and indexed by The Graph. `npm run doctor` re-verifies each of those against the Hedera mirror node, the Sepolia RPC and the Subgraph. The React application covers market browsing, a market detail and order ticket, curve publishing, holdings with redemption, the creation workflow and an operator screen. Local checks: 39 Foundry tests, 1 Anvil route test, 18 TypeScript unit tests and 13 PostgreSQL integration tests, including payment idempotency, requirement binding, ambiguous-settlement reconciliation, discount limits and request authorization. Details in [docs/EVIDENCE.md](docs/EVIDENCE.md).

### Phase 4 — Verification and submission: Day 4

- [x] Run contract, arithmetic, routing, payment, and browser-flow checks (the browser flow was driven through drafting, approval, the verification state and the live 402 requirements; it stops at the wallet signature).
- [x] Verify public deployment addresses and document centralized creation/resolution roles.
- [ ] Finish the World feedback document and sponsor-specific evidence (sponsor evidence is complete; [docs/WORLD_FEEDBACK.md](docs/WORLD_FEEDBACK.md) is written with its Sandbox sections deliberately left blank until a credential is granted).
- [ ] Record a three-to-four-minute demo using actual transactions and live indexed data.
- [ ] Reserve the final half-day for fixes, deployment checks, documentation, and submission (documentation is done; deployment and submission remain).

**Exit:** public repository, working application/API, contract/payment transaction evidence, Graph endpoint, World feedback, and demo video are ready. Prize eligibility is assessed against the actual implementation, not this plan. **Outstanding:** a browser-wallet payment, a verified World credential, public HTTPS hosting, and the demo recording.

**Documentation:** [docs/SETUP.md](docs/SETUP.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (including the x402 payment flow), [docs/EVIDENCE.md](docs/EVIDENCE.md) and [docs/WORLD_FEEDBACK.md](docs/WORLD_FEEDBACK.md) are public and exclude the private planning notes.

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
