# horizon_events

Every event Horizon's own contracts emitted in one Sepolia block, in log order, as one
`horizon.v1.HorizonEvents` message. Consumed by `src/stream-consumer.ts`, which records each block
in the live layer beside the market mirror; see "Live layer" in `docs/ARCHITECTURE.md`.

Modules: `map_registry_events` (MarketCreated only) → `store_markets` (market addresses) →
`map_horizon_events` (everything, with per-market events kept only for known markets). Contract
addresses arrive as params written from `deployments/sepolia.json` by `npm run substreams:pack`.
