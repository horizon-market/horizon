# Horizon — idea, architecture, sponsor fit, and continuation context

Planning snapshot: **September 8, 2026**. Event: **ETHOnline 2026**. Team: **one human builder with AI assistance**. Original delivery window: **four days**.

This document preserves the conversation so a new task can continue without rediscovering the idea. Read [README.md](/Users/xana/work/ethglobal2026/horizon/README.md) for the roadmap and [OPERATIONS.md](OPERATIONS.md) for setup, evidence, and limitations. Update September 9: **Phase 2 is implemented and verified live**: curve presets, direct/complementary routes, shared-wallet-aware quoting, Sepolia contracts, and a live Subgraph. [PHASE2.md](PHASE2.md) records interfaces, arithmetic, API usage, transaction evidence, and scope limits. React, AI-assisted creation, live Hedera payments, and World verification remain Phase 3 work.

## 1. Product thesis

Horizon is a prediction market with user-defined executable pricing curves and USDC liquidity shared across markets through 1inch Aqua. People and agents can request general binary markets through a centralized AI creation service, paying through Hedera x402. World verification supports a creation discount, and The Graph supplies market and liquidity data to both the application and the AI.

Suggested pitch:

> Horizon lets people turn their knowledge into executable prediction curves, reuse available USDC across markets, and create fully backed outcomes when complementary buyers meet. Market creation combines live on-chain discovery, AI assistance, agent payments, and verification-based access to a lower creation price.

The original motivation is that permissionless market creation can produce many empty markets. Small-budget users also face friction expressing a view across multiple prices without programming a trading bot. Horizon aims to make posting these views easier and reduce capital fragmentation while retaining explicit user control over inventory and risk.

The initial audience is individual forecasters, small makers, outcome holders wishing to sell, and agents that create or trade markets. The MVP supports general binary questions; sports-only and short-duration crypto-only versions were discussed but not selected.

These are hypotheses to demonstrate, not guaranteed outcomes: shared balances do not create money, ensure two-sided markets, establish forecast accuracy, or eliminate the need for counterparties. A small trader can contribute an executable quote, but market prices are not one-person-one-vote measurements.

## 2. Confirmed decisions and changes from earlier suggestions

- **Separate project:** use Horizon, not a renamed ArcBook. The user permits looking at the earlier project for ideas and understanding. No wholesale ArcBook reuse has been authorized or performed.
- **Only USDC is shared across different markets.** An outcome token must match the market and outcome named by its strategy.
- **Complementary buyers create initial outcomes.** Requiring everyone to pre-mint outcome inventory was offered and not chosen as the primary bootstrap flow.
- **Outcome resale is deliberate.** A holder publishes a sell curve when they want to sell. Automatic recycling into an opposite curve was rejected.
- **Equal price endpoints are supported.** This is a fixed-price limit order, not a guarantee of immediate execution.
- **Shape presets, not unrestricted alpha**, are the selected MVP scope.
- **Off-chain routing, on-chain atomic execution** are required, including fills against multiple curves.
- **Trader-triggered matching** was chosen over a funded background keeper.
- **General binary markets** were chosen over a crypto-only template.
- **Admin resolution** was selected: YES, NO, or INVALID, with evidence and published rules. INVALID pays 0.50 USDC per outcome token.
- **All four sponsors are required.** An Aqua/Graph-only fallback was offered and not selected.
- **Both user-wallet and agent x402 payments** are required. Sponsored browser payments alone do not satisfy the chosen product scope.
- **World access is not known.** This is an early prerequisite to check, not a completed integration.

### Fee interpretation

The user explicitly asked to mention that Horizon has no fee. The conversation recorded this as **zero trading fees: no maker, taker, routing, or Horizon protocol trading fee**, while preserving the original separate x402 market-creation charge. Network gas remains separate.

The creation price, discount amount, and discount frequency are not independently user-confirmed. The earlier roadmap proposed **1 testnet HBAR**, reduced to **0.5 HBAR**, with one discounted creation per credential per UTC day. Treat these numbers as configurable demo defaults, not settled business policy. If the user later clarifies that creation must also be free, revisit the paid-service design explicitly rather than hiding a charge.

## 3. Economic model and examples

### Shared USDC is available capital, not multiplied capital

Alice has 50 USDC in her wallet and authorizes buying curves in markets A and B. Both may reference that balance. If a fill in A spends 20 USDC, only 30 USDC remains for other buys, absent incoming funds. Displaying both original allocations as independently executable would overstate liquidity.

USDC sharing is per wallet and per chain. It does not share money between unrelated users or bridge assets between the EVM trading network and Hedera. After a fill, refresh other affected quotes; Aqua strategy allocations alone are not authoritative wallet balances. See the [Aqua shared-liquidity overview](https://business.1inch.com/portal/documentation/aqua/overview).

Sharing across markets is deliberate and is kept. Promising the same money twice **inside one market** is not. Every order a maker has resting in one market that spends the same token is added together, and a new one is refused unless the total still fits within `min(balance, allowance to Aqua)` for that token — so in market A those orders may commit at most Alice's 50 USDC, while market B may separately commit the same 50. A BUY spends USDC whichever outcome it names, so buying YES and buying NO share one budget; each outcome token is its own inventory. Obligations are the exact curve integral over the size an order has left, so a partial fill releases exactly what it spent and nothing more. The rule is enforced on chain when an order is admitted to the router, not in the service. `docs/ARCHITECTURE.md` states it in full, including what it deliberately does not do.

### Market-specific outcome inventory

YES for market A is a different token from YES for market B. A Horizon strategy must pair the configured USDC contract with the registered YES or NO token of one market. Validate contract addresses and registry membership, never token symbols.

A user acquiring YES now has inventory. That inventory becomes publicly offered sell liquidity only after the user authorizes a sell curve. Token-market validation naturally prevents cross-market outcome substitution, and the per-market order budget keeps several sell orders on the same outcome from offering that inventory more than once: YES and NO are different tokens and therefore different budgets. Neither reserves the balance — outcome availability must still be refreshed when quoting, and no order is promised a fill.

### Complementary minting

To create one pair, the combined buyer contributions must fund one USDC of collateral. For example:

- A trader wants YES and contributes 0.60 USDC.
- A resting NO-buy curve contributes 0.40 USDC through the maker's Aqua authorization.
- One USDC enters escrow; one YES goes to the trader and one NO to the maker.

The proposed pricing convention fills the resting complementary maker at its executable curve price and charges the initiating trader the remainder needed for full collateralization, subject to the trader's limits. All contributions, minting, and distributions occur atomically.

For variable-price fills, use integrated costs over the executed quantity, not the starting marginal price times the whole quantity. A fill of Q paired shares requires Q USDC of collateral after unit conversion; rounding must never underfund escrow. There is no unexplained spread retained by Horizon.

### Escrow and redemption

Wallet USDC available to Aqua is distinct from USDC already locked to back outcome tokens. Once collateral is escrowed, it cannot also fund another market's orders.

After trading closes, the disclosed admin submits the result and evidence. YES or NO resolution pays one USDC per winning token and zero for the loser. INVALID pays half a USDC per token. Redemption burns or marks the claim as consumed. Outstanding claims must remain covered at all times, including rounding/dust behavior.

## 4. Curves and execution design

The agreed feature is start/end prices, a size or budget, and a small set of shapes. Phase 2 implements and tests this kernel with presets 1, 2, and 3:

`p(x) = p_start + (p_end - p_start) * x^alpha`, with `x = filled_shares / total_shares` and `alpha` in `{1, 2, 3}`.

Prices are USDC per outcome share. Buying curves decline as the maker accumulates outcomes; selling curves increase as the maker distributes inventory. Equal endpoints bypass shape differences and behave as a flat order. Trade amounts come from the integral between the old and new fill positions.

For total size Q and fill coordinate q, the real-number cumulative cost is:

`C(q) = p_start*q + (p_end-p_start)*q^(alpha+1) / ((alpha+1)*Q^alpha)`.

`CurveMath` and the TypeScript quote service implement the exact rational cumulative integral: BUY rounds down, SELL rounds up, and fill amounts are cumulative differences. Price and quantity units have six decimals, with size capped at `1e15` base units to bound intermediates. The Anvil integration test compares 44 actual contract outputs with TypeScript calculations across shapes, directions, and boundaries. Aqua allocation bounds the maker's spending/inventory; the frontend must relate its budget control to a supported size. Executable quoting uses bigint throughout. Details and tiny-fill behavior are in PHASE2.md.

Each strategy binds maker, market, outcome token, direction, price endpoints, shape, quantity/budget, and a unique identifier. Filled quantity is persistent and must not reset on each execution. Cancellation disables future fills; changing terms uses cancellation and republication.

### Custom SwapVM responsibilities

Extend official SwapVM with a Horizon pricing/validation instruction while retaining Aqua authorization and settlement. The extension must enforce market/token checks on the actual execution path, including attempts to submit unexpected programs or bypass the Horizon frontend. An arbitrary `Aqua.ship()` record is not sufficient proof of a valid Horizon market strategy.

This is now literal rather than aspirational: `Aqua.ship` has no application callback, so a strategy naming the Horizon router can be published without asking Horizon at all. `HorizonSwapVM` therefore requires a second step, `admitCurve`, and refuses to fill any order that has not taken it. Admission is where the per-market order budget is checked, and it is the only place a publication can be refused for a reason the maker cannot route around. A shipped-but-unadmitted order holds its maker's Aqua allocation, commits nothing, is excluded from discovery and quoting, and can be docked to recover the allocation. The ledger itself lives in `OrderBudget`, a separate contract the router deploys and owns; keeping it out of the router is also what keeps the router inside the EIP-170 size limit.

Phase 1 implements and locally tests output-first settlement and the pre-transfer-in callback in SwapVM: receive maker USDC, combine the trader's contribution, mint, and deliver the complementary outcome before completing the swap. `ComplementaryExecutor` binds the callback to its router, active order, maker, market-derived input token, amounts, and recipient; public execution uses a reentrancy guard. A failure in the final Aqua push rolls back minting and both contributions. This is local contract evidence, not a deployed sponsor demonstration.

The current `HorizonSwapVM.BuyStrategy` binds market, YES/NO side, fixed price, maximum shares, and salt. Price and token quantities use six decimals. Cumulative maker cost is `floor(filled * price / 1e6)`; a fill pays the difference between cumulative endpoints, and the taker pays the exact remainder needed for collateral. Both contributions must be positive. Tiny fills may therefore be rejected; splitting a fill does not change total maker cost. This is the implemented flat-price baseline; shaped curves must retain explicit accounting and overflow bounds.

`BinaryMarket` stores half of a USDC base unit per redeemer when INVALID claims round down. A later claim by the same account consumes that remainder. Fractions held by different accounts are not combined, so sub-micro-USDC dust can remain escrowed; there is no administrator sweep. No normal six-decimal USDC amount is taken as a protocol fee.

### Route types

- **Buy an outcome directly:** pay USDC to a maker selling that same outcome.
- **Buy through complementary minting:** combine USDC with a maker buying the opposite outcome, then mint and distribute the pair.
- **Sell an existing outcome:** deliver it to a maker buying that outcome and receive USDC.

A buy route can mix the first two types because they deliver the same outcome. Routes stay within one market. Complementary sell-and-merge routes, cross-market paths, and automatic matching are deferred.

The implemented route cap is four fills. The deterministic allocator performs a bounded chunk search over up to 32 Graph-discovered candidates, respects quantities and shared maker budgets, refreshes live state at one block, and simulates the entire selected transaction when the account is funded and approved. It provides exact amounts for the selected route, not an unconditional global optimum; its bounds and conservative treatment of incoming proceeds may exclude other executable routes.

The executor checks market/outcome identity, authorized strategies, current fill state, funding, user limits, deadline, and callback context. It executes legs in a defined order, refunds unused user input, and fully reverts if any leg fails. The solver proposes a route; it cannot override contract constraints.

## 5. Creation, identity, payments, and data

### Creation flow

1. A browser user or agent proposes a binary question.
2. The centralized AI reads live Graph-indexed markets, explains duplicates or overlap, and drafts unambiguous resolution criteria.
3. The requester reviews the draft, including evidence source, trading close, and resolver. A duplicate recommendation can direct them to an existing market before payment.
4. Optional World verification establishes discount eligibility. The backend verifies the proof and binds eligibility to the request and requester.
5. The creation API issues x402 payment requirements reflecting eligibility. The user's wallet or agent signs the Hedera payment; Blocky402 verifies and settles it.
6. The service deploys/registers the approved market on the EVM network and records the result under a durable request ID.
7. The Subgraph indexes creation and the frontend displays the market and actual available liquidity.

This is open access to a centralized creation service, not a claim that market validation and resolution are decentralized. The AI should not autonomously change market rules after trading begins or resolve arbitrary questions without the selected admin process.

### Payment recovery

Use durable request IDs, payload binding, and uniqueness constraints for payment receipts and market creation. Network retries must not repeat charges or create duplicate markets. A payment that settled before an EVM deployment failure remains attached to a recoverable request; retry the outstanding creation step without settling another payment. Ambiguous settlement must be reconciled before deciding to charge again.

Use a native Hedera signing adapter for the browser and an agent-owned signer for agent requests. The planned first browser wallet is HashPack via Hedera WalletConnect/Reown. Its actual signing compatibility is an early test, not an assumed completed feature. Do not collect browser users' private keys. [Hedera wallet integration](https://github.com/hashgraph/hedera-wallet-connect), [Blocky402 examples](https://blocky402.com/docs/examples/)

### Meaning of World verification

Verification is an eligibility/abuse-resistance signal, not proof of prediction quality or proof that a human wrote the text without AI assistance. Record request origin and verification credential separately. An agent can act for a verified person, and an unverified requester may still be human.

Selfie Check does not give a strict one-person-one-account guarantee. Keep discount scope bounded and prevent replay; do not label a self-declared agent/human field as cryptographic proof. Its documentation also describes access gating. [Selfie Check documentation](https://docs.world.org/world-id/credentials/11)

### The Graph and live chain state

Index canonical market metadata, outcome addresses, deadlines, strategies, fills, cancellation, and resolution. Record the indexed block for quote provenance. Expose this dataset to the AI as well as market discovery and routing.

The Graph is a source of indexed blockchain data, not the final settlement authority. Refresh actual wallet balances, allowances, fill state, and market status through RPC before simulating a transaction. Wallet changes may occur outside Horizon. Expiry is enforced by contract time even if no new indexing event has updated a displayed status.

PostgreSQL stores service workflow state: drafts, requests, receipts, and discount usage. It must not become an alternative source of truth for collateral balances or contract payouts.

## 6. Sponsor fit and required evidence

Official event pages were checked on **September 8, 2026**. The fit assessments below are design judgments; prizes are competitive and qualification depends on the delivered implementation. Recheck the pages before submitting.

### 1inch — Build an Aqua App

**Why Horizon fits:** the product depends on Aqua for shared maker USDC and uses a custom SwapVM instruction for prediction-specific curve execution. Complementary minting and bounded route execution demonstrate more than a cosmetic integration.

The published track requires official Aqua/SwapVM contracts, permits modified SwapVM redeployments, requires demonstrated token transfers, and expects incremental Git history. SwapVM use receives additional scoring. Local forks can satisfy its transfer demonstration requirement, but Horizon needs a live deployment for its other integrations.

**Evidence:** pinned official dependencies, the custom instruction and validation path, real transfers, shared-balance depletion across markets, and an atomic multi-fill transaction.

[Official 1inch prize page](https://ethglobal.com/events/ethonline2026/prizes/1inch)

### The Graph — Best AI Tooling or AI Use Case

**Why Horizon fits:** the creation AI uses live market data to explain duplication and decide whether to propose a new market. Routing also consumes indexed strategies. The meaningful AI dependency is the intended prize argument.

The AI track requires live Graph-provider data, substantive use of it, public code/documentation, and a two-to-four-minute demo. Local-only, mocked, or static data is insufficient. A basic single-Subgraph application does not qualify for the separate composability track without the required composition or standardization.

**Evidence:** deployed Subgraph queries, an AI response grounded in existing market IDs/data, a duplicate/overlap decision, and live creation appearing in the dataset.

Start Fresh excludes prior project-specific code; Continuity covers extensions with disclosed prior work. Horizon is planned as a separate new implementation, but actual code provenance determines the appropriate entry. Referencing ArcBook does not authorize claiming copied prior work as newly written.

[Official Graph prize page](https://ethglobal.com/events/ethonline2026/prizes/the-graph)

### Hedera — AI & Agentic Payments

**Why Horizon fits:** market creation is a real service that both agents and people can purchase by request through x402. The service produces a usable market rather than merely recording a payment.

The track requires a live Hedera testnet/mainnet x402 service settled through Blocky402, an end-to-end real paid request, a public repository with setup/architecture/payment-flow documentation, and a demo of at most five minutes.

**Evidence:** payment-required response, payer authorization, facilitator settlement, transaction receipt, and the resulting creation request/market. Include both browser and agent flows to meet Horizon's chosen product scope, even though the sponsor's minimum is narrower.

[Official Hedera prize page](https://ethglobal.com/events/ethonline2026/prizes/hedera)

### World — Selfie Check

**Why Horizon fits:** a bounded creation discount is an eligibility and abuse-resistance use of verification. The effect must be demonstrated through a changed payment requirement, not only a badge.

The track calls for meaningful Selfie Check or a compatible credential flow, a working app, and feedback covering the credential integration, developer portal, and Sandbox behavior/errors. The separate AgentKit prize is a Continuity track; a generic World ID integration does not automatically qualify for either prize.

**Evidence:** credential completion and server verification, discounted versus ordinary payment requirements, replay/eligibility behavior, and the required feedback document. World access was not confirmed during planning and must be checked immediately.

[Official World prize page](https://ethglobal.com/events/ethonline2026/prizes/world)

## 7. Architecture boundaries and proposed interfaces

These are capability boundaries, not finalized ABI or HTTP endpoint names:

- **Market registry/escrow:** create and inspect markets; bind YES/NO addresses; accept fully funded pair minting; close, resolve, and redeem.
- **Horizon SwapVM extension:** validate and price a single registered strategy, account for partial fills, and use Aqua for maker settlement.
- **Route executor:** accept one market/outcome/action, selected legs, user amount limits, recipient, and deadline; coordinate mint callbacks and atomic settlement.
- **Quote API:** accept market, outcome, direction, and amount; return selected fills, amounts, snapshot/state information, limits, expiry, and calldata.
- **Creation API:** draft/review, credential verification, x402 payment requirements, durable creation request, and status/retry access.
- **Agent client:** consume the same public creation/payment interface as the browser; no separate business rules.
- **Frontend:** market discovery, market details, curve editor, buy/sell quote review, holdings/redemption, creation, and admin resolution.

Keep financial amounts as integers with explicit token units at API boundaries. User wallet transactions remain separate from server-owned administrative deployment/resolution permissions. Authentication or database admin access alone must never authorize arbitrary spending from user wallets.

## 8. Stack discussion and outstanding decisions

The user initially suggested Django, then **selected a TypeScript backend**. The assistant's recommended stack is **Solidity/Foundry + React/Vite/TypeScript + Node/Express/TypeScript + PostgreSQL**, mainly to share off-chain math and route types across frontend, backend, and agent client. Do not reopen the backend-language decision in a new task.

The user specifically asked whether TypeScript would make an admin panel, Celery-style tasks, or an ORM difficult. Phase 0 now implements those foundations with AdminJS, Prisma, and pg-boss: authenticated record inspection, migrated PostgreSQL models, and a separate worker with persisted jobs and tested retries. Versions are pinned in package.json and package-lock.json. The supporting tools were selected during implementation; TypeScript was explicitly chosen by the user. Keep contract/off-chain agreement tests as financial functionality is added.

### Recommended admin, ORM, and background-job setup

- **AdminJS:** attach an authenticated admin interface to Express, using a compatible Prisma adapter for model-based lists, filters, and record inspection. Use it for creation requests, payment receipts, discount usage, job status, and resolution evidence. Add deliberate service actions for retrying a request or submitting an authorized resolution. Contract-derived balances, settlement evidence, and market results must not be freely editable database fields. Configure authorization and audit records explicitly; AdminJS is an integration, not Django's bundled admin. [AdminJS Prisma integration](https://docs.adminjs.co/installation/adapters/prisma)
- **Prisma + PostgreSQL:** use an ORM for models, relationships, database migrations, and transactional service-state changes. Financial amount fields use explicit integer units. ORM transactions cover database writes, not atomicity with Hedera or EVM transactions; retain reconciliation and request IDs. Verify a compatible ORM/admin-adapter version pair before pinning. Current Prisma APIs have changed across major releases, so do not combine an older adapter example with a newer client without checking it. [Prisma documentation](https://www.prisma.io/docs/orm), [AdminJS compatibility guidance](https://docs.adminjs.co/installation/migration-guide-v7)
- **pg-boss:** use a PostgreSQL-backed job queue for AI generation, creation after payment, transaction-receipt reconciliation, scheduled checks, and retries with backoff. Start the worker as a separate persistent process using the same backend codebase. This uses the planned database without adding a Redis deployment. The project also offers job/queue monitoring tooling. Queue retries do not guarantee exactly-once external side effects: every payment/deployment handler must check durable request state and transaction receipts before acting again. Enqueue work consistently with request persistence and recover interrupted workflows. [pg-boss documentation and features](https://github.com/timgit/pg-boss)

BullMQ is another Celery-style option with retries, schedules, and worker concurrency; its standard Redis-backed setup would add another service. It is an alternative, not an additional queue to run alongside pg-boss for this MVP. [BullMQ documentation](https://docs.bullmq.io/)

The minimum operational layout is an HTTP API/admin process, a worker process, and PostgreSQL. The user subsequently selected Docker for local PostgreSQL; Compose initializes the application and test databases, and the earlier native cluster is preserved but stopped. Choose hosting that can run the worker continuously or provide an equivalent durable execution model; returning an HTTP response must not be assumed to keep an in-process task alive. These are service-maintenance jobs, not an autonomous market matcher or an AI resolver. Market close checks remain enforced on-chain even if a scheduled job is late.

Proposed defaults from the roadmap, subject to implementation validation:

- Ethereum Sepolia, Circle test USDC, and a verified official Aqua registry for trading.
- Hedera testnet with HBAR-denominated creation payments.
- Separate ERC-20 outcome tokens, polynomial alpha presets `{1,2,3}`, and at most four route fills.
- PostgreSQL for durable service state; no autonomous trading keeper.
- HashPack as the initial Hedera browser-wallet target.
- Testnet creation price/discount defaults described in Section 2.

Open work that should not restart product discovery:

1. **Supporting-library follow-up:** the pinned Express/AdminJS/Prisma/pg-boss stack passes local integration checks. Resolve or assess recorded transitive dependency advisories before exposing the admin publicly; real creation/payment handlers and admin actions are not implemented yet.
2. **External access:** the user will provide testnet accounts/APIs later. World app/Sandbox enablement, Graph credentials, funded wallets, RPC access, and payment receiver setup remain pending.
3. **Contract integration:** source compatibility and the custom opcode hook are tested locally. Verify official deployed bytecode and implement/deploy Horizon's market-aware router; avoid mixing APIs from different generations.
4. **Implementation precision:** finalize outcome decimals, normalized price/quantity units, integer rounding, dust redemption, and buy-budget sizing before the curve kernel is considered executable.
5. **Service configuration:** final demo creation amount and discount limits, LLM provider, and hosting target. Earlier values are proposals, not user approvals.
6. **Resolution timing:** define the close/resolution schedule and behavior if the admin does not resolve. An oracle/dispute system is out of scope, but the UI must disclose dependence on the resolver.
7. **Submission provenance:** document actual reuse and choose the pool that matches it. Do not assume a new folder by itself establishes Start Fresh eligibility.

## 9. Local references and what has actually been inspected

- [Aqua checkout](/Users/xana/work/ethglobal2026/aqua): read for the wallet-based allocation and transfer model.
- [SwapVM checkout](/Users/xana/work/ethglobal2026/swap-vm): inspected for output-first settlement and pre-transfer-in callbacks.
- [ArcBook reference](/Users/xana/work/ethglobal2026/liquid_OB/README.md): prior-event project with curves, a solver, atomic batch execution, and indexing. Its automatic two-sided inventory recycling is not Horizon's selected behavior.

Observed checkout HEADs during planning were Aqua `9c5c42e5840e8741fba3597c48456c9510212b66` and SwapVM `9502fd44254fef12fa448c3059868505b4c9dfff`. Implementation pins SwapVM at that revision and Aqua at its declared dependency, `v1.0.0` / `098b4c5d8eec67677f7ca861ca991af56024d9c5`. Exact origins, licenses, and retained source hashes are recorded in `contracts/vendor-lock.json` and `contracts/README.md`. These are source pins, not verified deployments. The newer SwapVM API differs from ArcBook's older integration.

Horizon now compiles under Node 24.10.0/TypeScript 5.9.3 and Solidity 0.8.30/Foundry 1.2.3. Two unit tests, three actual PostgreSQL integration tests, and three protocol tests pass locally. The custom test router enables LimitSwap through `_runOpcode`; the default Aqua dispatcher omits it. Tests establish token transfers, callback ordering, and shared-wallet depletion using mock assets. They do not prove a backed complementary match. Wallet payment integration, public deployment, live Graph/World flows, and the complete product remain unimplemented. See OPERATIONS.md for exact commands and pending prerequisites.

Consult applicable local instructions before implementation. The user-provided workspace instruction references `/Users/xana/.codex/RTK.md`, which requires shell commands to be prefixed with `rtk`. If operating inside the SwapVM checkout, also read its own `AGENTS.md`.

Other primary references:

- [Aqua contract/deployment reference](https://business.1inch.com/portal/documentation/aqua/reference/contract-addresses)
- [Custom AquaApp development](https://business.1inch.com/portal/documentation/aqua/getting-started/build-an-aquaapp)
- [Aqua access model](https://business.1inch.com/portal/documentation/aqua/liquidity-layer/access-resolvers-and-pathfinder)
- [Official Aqua source](https://github.com/1inch/aqua)
- [Official SwapVM source](https://github.com/1inch/swap-vm)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

## 10. Demo narrative and practical limits

Show a requester drafting a general binary question. The AI cites live existing markets and explains the creation decision. A World-checked requester sees a lower creation price, pays through a browser wallet, and obtains a market. An agent also completes a paid request.

Then show one maker's USDC backing buying curves in two markets. A trader buys an outcome through complementary minting, receiving one side while the maker receives the other. The maker's remaining USDC capacity falls across the shared markets. An outcome holder deliberately publishes a sell curve; a later trader's order uses multiple curves in one transaction. Finish with resolution evidence and redemption.

Use actual transactions and clearly labeled testnet assets. Measure and show executed quantities, prices, wallet balances, and collateral rather than counting virtual allocations as multiplied capital. A market with no counterparties can still be empty; the product reduces fragmentation and supports discovery, but does not guarantee a market for every question.

The main delivery risks are the complementary-mint callback, exact arithmetic, stale/shared-balance routing, browser Hedera signing, and World access. Put proofs for these early in the roadmap. All four integrations remain required; completion claims require evidence, and prize awards cannot be guaranteed.
