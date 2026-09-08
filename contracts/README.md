# Horizon contracts

Phase 1 implements the market lifecycle and a fully backed fixed-price complementary match against pinned Aqua/SwapVM. **Phase 2 adds curves, direct trades, and atomic four-fill routes, deployed and verified on Sepolia with live Graph indexing.** Local verification: **39 tests pass**, including three fuzz properties with 256 cases each. See [PHASE2.md](../PHASE2.md) for the current interfaces, rational integral, API, deployment addresses, and real two-fill transaction. The Phase 1 interfaces below remain available for compatibility.

Run from the repository root:

```sh
npm run vendor:verify
npm run contracts:build
npm run contracts:test
npm run contracts:demo
```

Solidity is pinned to 0.8.30 with Cancun EVM, optimizer 700, and via-IR. Local verification used Foundry 1.2.3. Cancun support matters because SwapVM uses transient storage.

## Implemented contracts

- `MarketRegistry`: the creation-service owner creates markets with unique creation IDs. Its two-step owner transfer changes future creation authority, never an existing market's rules or resolver. Anyone will be able to request market creation through the service; the current factory call itself is authorized.
- `BinaryMarket`: one isolated USDC escrow per market, fixed question/rules/evidence source/close timestamp/resolver, permissionless fully backed pair minting, timestamp-based closing, one admin resolution, and claim redemption. Metadata has no setters. There is no collateral withdrawal or fee recipient.
- `OutcomeToken`: six-decimal YES or NO bound to its immutable market. Only that escrow can mint or burn. Holders can transfer claims normally; redemption burns only the caller's tokens.
- `HorizonSwapVM`: extends the pinned official Aqua router through the virtual opcode hook. Its application-local `0xf0` instruction implements a fixed-price maker BUY, checks the registry and exact tokens, and tracks filled shares. Vendor sources are unmodified. No fee opcode is enabled.
- `ComplementaryExecutor`: Phase 1 single-order compatibility executor; not part of the live Phase 2 deployment.
- `CurveMath`: exact cumulative rational integral for presets 1, 2, and 3, with explicit size/price bounds and BUY/SELL rounding.
- `RouteExecutor`: live Phase 2 executor, supporting up to four direct/complementary curve fills with exact share size, expected fill state, maximum buy spend/minimum sale proceeds, deadlines, refunds, and complete rollback.

The deploy order is registry (USDC, creation owner), router (Aqua, registry, rescue owner), RouteExecutor (router). The router inherits upstream rescue authority over accidentally held router assets; it cannot withdraw market collateral. Generated ABI artifacts are under `contracts/out/<File.sol>/<Contract>.json` after building. The deployed addresses and source verification are recorded under `deployments/`.

## Publish and fill a fixed-price BUY

1. The registry owner calls `createMarket(creationId, question, rules, evidenceSource, closeAt, resolver)` before the deadline. All text fields must be nonempty. The service remains responsible for meaningful, resolvable questions.
2. Build `BuyStrategy({market, buyYes, price, maxShares, salt})`. `price` is micro-USDC per whole outcome, strictly between 0 and 1,000,000. `maxShares` is a `uint128` count of outcome base units. Both outcomes and USDC have six decimals.
3. Call `router.buildBuyOrder(maker, strategy)`. The maker approves USDC to **Aqua**, then calls `Aqua.ship(router, abi.encode(order), [outcome, USDC], [0, budget])`. For a fully funded allocation, `budget = floor(maxShares * price / 1e6)`. The zero outcome allocation is intentional: a buyer starts without outcome inventory. Aqua requires both tokens to be registered in the strategy even when one allocation is zero. Each publication needs a unique salt if all other terms match an earlier order.
4. The taker approves USDC to **ComplementaryExecutor** and calls `execute(maker, strategy, shares, maxTakerUSDC, recipient, deadline)`. The taker receives the opposite side from `strategy.buyYes`. This is exact-share execution: a requested quantity either fills completely or reverts.
5. To cancel, the maker calls `Aqua.dock(router, orderHash, [outcome, USDC])`. To change terms, publish a new order; filled counters cannot be reset through donation or reallocation.

For a resting NO buyer at `price=400000` and `shares=1000000`, the taker spends 600000 USDC units. Aqua sends 400000 maker USDC units to the executor first. The callback verifies its complete active context and that 1000000 units have arrived, then escrows them, mints 1000000 YES units to the taker's recipient, and mints 1000000 NO units to the executor. SwapVM transfers those NO units through Aqua to the maker. Temporary approvals are cleared and no fees or trade balances remain in the executor/router. Tokens donated beforehand are preserved, not spent to subsidize a fill.

Acquiring outcomes creates no sell authorization. A direct seller can explicitly approve and deliver existing matching outcomes to the fixed BUY through SwapVM, but publishing SELL strategies and routing direct trades through the product are Phase 2 work.

## Arithmetic, lifecycle, and trust boundaries

The maker's cumulative spend is `floor(filledShares * price / 1e6)`. A fill pays the difference between the new and old cumulative values; the taker pays `shares - makerSpend`. This makes total maker cost independent of splitting, keeps the posted price fixed as Aqua balances change, and guarantees full collateral on every mint. The `uint128` size cap and price bound keep multiplication within `uint256`. Both contributions must be positive; some tiny quantities or final dust fills are rejected. `maxTakerUSDC` protects the taker from the one-base-unit effects of prior fills and rounding.

The executor quotes through a static call, binds the returned amounts and hash, transfers the exact taker cost, then swaps with output-first settlement. Public execution is guarded against reentrancy; callbacks require the configured router, an active unused order, exact participants/tokens/amounts, and the expected USDC balance. A failure after pair minting still reverts **all** collateral, token issuance, contribution transfers, approvals, and filled counters.

Only canonical BUY orders use the Horizon instruction. It reconstructs and hashes the complete maker order, rejecting changed tokens, receiver, hooks, traits, extra instructions, and signature mode. The inherited generic SwapVM entry points remain available: do not interpret every arbitrary `Aqua.ship` record as a valid Horizon strategy. Canonical validation is required during discovery. A different program has a different Aqua authorization and cannot reuse a legitimate BUY's allowance.

Aqua allocations are permissions, not reserved wallet funds. Static quotes read strategy state but do not guarantee the maker still has sufficient wallet balance/allowance. Phase 2 must refresh shared wallet capacity and simulate complete routes. The local test explicitly spends a shared wallet in market A and shows market B reverting without effects, despite its still-positive allocation.

At `block.timestamp >= closeAt`, minting and Horizon fills stop even if nobody submits `close()`. The immutable resolver can then resolve exactly once to YES, NO, or INVALID with a nonempty evidence reference. The admin role is centralized and there is no dispute or timeout fallback in this MVP. YES/NO pays one USDC per winning outcome; losing tokens can be burned for zero. All redemption burns the caller's claims before transferring collateral.

INVALID pays half per outcome. Since USDC cannot transfer half of one base unit, `invalidRemainder[holder]` retains that fraction for the holder's next claim. Combining or splitting that holder's claims preserves total payout. Fractions at different accounts are not transferable/combined, so tiny dust may remain escrowed permanently; there is no admin sweep. The escrow tracks backing separately from unsolicited USDC donations.

## Events for The Graph

Index `MarketRegistry.MarketCreated` to discover market/token contracts and their fixed rules. Use dynamic market templates for `PairMinted`, `CollateralChanged`, `MarketClosed`, `MarketResolved`, and `Redeemed`; token `Transfer` events support holdings. Trading closes by timestamp, so do not rely on a `MarketClosed` transaction being sent promptly.

Track Aqua `Shipped`/`Docked` for publication/cancellation, filtering the Horizon app address and validating the complete canonical order. `BuyFilled` gives market, maker, side, fill quantity, USDC spend, and cumulative filled size. `ComplementaryMatched` gives both buyer contributions and the taker/recipient; upstream `Swapped` supplies the actual settlement pair. These events exist and are tested locally; a deployed Subgraph and Graph-backed API are the next phase.

## Source provenance

- `vendor/aqua`: official [1inch/aqua](https://github.com/1inch/aqua/tree/098b4c5d8eec67677f7ca861ca991af56024d9c5), commit `098b4c5d8eec67677f7ca861ca991af56024d9c5`, tag `v1.0.0`. This is the dependency requested by the selected SwapVM revision, rather than the initially inspected Aqua HEAD.
- `vendor/swap-vm`: official [1inch/swap-vm](https://github.com/1inch/swap-vm/tree/9502fd44254fef12fa448c3059868505b4c9dfff), commit `9502fd44254fef12fa448c3059868505b4c9dfff`.
- `vendor/solidity-utils`: official npm archive `@1inch/solidity-utils@6.9.10`.
- `vendor/openzeppelin`: official npm archive `@openzeppelin/contracts@5.4.0`; upstream LICENSE retained from the same tag.

The Git sources retain `src`, package metadata, LICENSE, LICENSES, and THIRD_PARTY_NOTICES. npm sources retain Solidity source and accompanying documentation; generated build/typechain artifacts were omitted. npm archive integrity was checked against registry SHA-512 metadata. [vendor-lock.json](vendor-lock.json) records origins and SHA-256 hashes of every retained file; `vendor:verify` detects missing, modified, and extra files. Source packages are vendored to avoid installing their unrelated Hardhat development dependency trees.

The included upstream licenses govern those files. Horizon does not relabel vendor code as its own. No ArcBook project code was copied into this foundation.

## What the probe proves

`test/ProtocolProbe.t.sol` deploys the pinned Aqua registry and a test extension of the pinned Aqua router. Aqua's default opcode dispatcher does **not** enable `LimitSwap`; the probe overrides `_runOpcode` to permit that instruction only. The vendored source remains unchanged.

Three tests establish:

1. A shipped order transfers 0.40 test USDC through Aqua and receives one pre-existing test outcome; USDC is already in the taker contract when its pre-transfer-in callback runs. No token amount remains as a router fee.
2. Two strategies referencing the same 0.40-USDC wallet balance cannot both spend it. The second fill reverts while its virtual allocation still exists, showing why the quote service must refresh actual balances.
3. A direct call cannot impersonate the router callback in this test harness.

These tests use freely minted mock ERC-20 assets. They establish settlement ordering and source compatibility, **not complementary minting or collateral conservation**. The callback observer is test-only and must not be deployed as Horizon's route executor.

## Next contract work

Phase 2's curves, SELL strategies, bounded routes, integer quote service, shared-wallet accounting, and live Graph discovery are complete. Phase 3 should consume their existing interfaces for publication, trading, positions, creation, and admin resolution. Preserve the lifecycle, wrong-market/token rejection, both complementary directions, donation isolation, cancellation, price/deadline limits, late-failure rollback, and collateral/rounding tests.

Sepolia deployment wiring and real transfers have been verified. The canonical Aqua address is the upstream AquaRouter wrapper, verified through Sourcify with exact matching core sources; its runtime differs from the locally compiled bare Aqua probe. See `deployments/aqua-verification.json` and `deployments/sepolia.json`.
