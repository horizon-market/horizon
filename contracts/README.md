# Protocol foundation

Phase 0 compiles official Aqua and SwapVM and runs a small local transfer probe. It does **not** implement a market registry, collateral escrow, backed outcome tokens, prediction curves, or a production router.

Run from the repository root:

```sh
npm run vendor:verify
npm run contracts:build
npm run contracts:test
```

Solidity is pinned to 0.8.30 with Cancun EVM, optimizer 700, and via-IR. Local verification used Foundry 1.2.3. Cancun support matters because SwapVM uses transient storage.

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

Implement the Phase 1 market registry, escrow, and registered outcome tokens. Replace the probe with a Horizon instruction that validates the exact configured USDC address and market-specific outcome token. Bind callbacks to the active route, router, order, market, amount limits, and recipient. Prove a 0.60 + 0.40 USDC complementary match that funds one complete pair atomically before building variable curves.

No deployed address is recorded yet. The address defaults in `.env.example` are candidates from official documentation. Verify Sepolia bytecode identity and deployment configuration before treating them as trusted integration targets.
