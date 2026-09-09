# Public evidence and disclosed roles

Everything below was verified against live networks. Anything not yet proven is listed in
"Outstanding" rather than implied.

## Deployed contracts — Ethereum Sepolia (chain 11155111)

| Contract | Address | Deployment transaction |
| --- | --- | --- |
| `MarketRegistry` | [`0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1`](https://sepolia.etherscan.io/address/0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1) | [`0x7bb78c17…`](https://sepolia.etherscan.io/tx/0x7bb78c175b6406d051977cb6b4e52bef40c1dbe080acf044d2b0e8b6cf4b9538) |
| `HorizonSwapVM` | [`0xf155c2ad43d020b601ee51a7e086112a5d00240f`](https://sepolia.etherscan.io/address/0xf155c2ad43d020b601ee51a7e086112a5d00240f) | [`0x5b11e74f…`](https://sepolia.etherscan.io/tx/0x5b11e74f86ded8717243adf51d1b11519c8a320951196c7937e50b1f5425275b) |
| `RouteExecutor` | [`0xede6eea88b6701e1c40dab0a9bba1cb8890e5bd4`](https://sepolia.etherscan.io/address/0xede6eea88b6701e1c40dab0a9bba1cb8890e5bd4) | [`0xc705bc81…`](https://sepolia.etherscan.io/tx/0xc705bc81e11dd1df4a7e3d32b908b1cdf070819676468b3bd3df43e400a01138) |

Dependencies, not deployed by this project: official 1inch Aqua router
`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` and Circle test USDC
`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. The Aqua deployment is the upstream `AquaRouter`
wrapper; Sourcify reports an exact runtime match and its core sources match the vendored pins byte
for byte. `deployments/aqua-verification.json` records the provenance and observed runtime hash,
and `npm run doctor` re-checks the live runtime hash against it.

Wiring verified on chain: the router points at the registry and at Aqua, the executor points at
the router, and the registry points at USDC.

## Indexing

Subgraph Studio version `0.2.0`, queried live at
`https://api.studio.thegraph.com/query/1758973/horizon/0.2.0`. This is a working Studio
deployment, not a claim of decentralized-network publication. It indexes markets, curves, fills,
routes, collateral and resolution, and validates Aqua publications against the deployed router
rather than trusting arbitrary `Shipped` bytes.

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
| `npm run doctor` | Sepolia, funding, Blocky402 capability, agent payment, Graph endpoint, indexed agent market, on-chain agent market and deployment wiring all `ok` |

## Outstanding

These are implemented but not yet demonstrated live, and are reported as `pending` by `doctor`:

- **Browser-wallet Hedera payment.** The Hedera WalletConnect client is implemented and the
  payment screen renders live requirements including the facilitator's fee payer, but no
  browser-wallet settlement has been completed and recorded. It needs a funded testnet wallet and
  a human approval.
- **World Selfie Check.** The full verification path is implemented and tested, but
  `WORLD_SELFIE_ACCESS` is `unknown`, so no credential has been verified and no discount has been
  granted. See [WORLD_FEEDBACK.md](WORLD_FEEDBACK.md).
- **Hosted-model drafting.** No AI credential is configured, so the deterministic provider runs.
  It is grounded on the same live Graph data and is labelled `development` wherever it appears.
- **Public HTTPS deployment.** The app runs locally and is not yet hosted.
- **Demo recording.**
