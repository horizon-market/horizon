## 1inch - Build an Aqua App

How are you using this Protocol / API?

Field 1 - Why you are applicable for this prize:

Horizon is a prediction market built on 1inch Aqua and SwapVM. Makers ship executable pricing curves to Aqua instead of resting orders, and one USDC balance backs quotes across every market. HorizonSwapVM extends the pinned official AquaSwapVMRouter with two custom opcodes, a fixed-price BUY and a start-to-end price curve, that reconstruct and hash the canonical Aqua order, enforce a per-market budget and track filled shares. ComplementaryExecutor uses SwapVM's output-first flow and preTransferInCallback to combine a YES buyer's and a NO buyer's USDC and mint a fully backed pair in one fill, and RouteExecutor settles up to four Aqua fills atomically or reverts the whole route. It is deployed on Sepolia against the canonical Aqua at 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a, with a real two-curve atomic route on chain, a Subgraph that validates Aqua Shipped events against the router, and vendor sources hash-verified on every CI run.

Field 2 - Link to the line of code:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/contracts/src/HorizonSwapVM.sol#L207

Field 3 - How easy is it to use (1-10):

7

Field 4 - Additional feedback for the Sponsor:

The _runOpcode virtual hook is excellent: a prediction-specific instruction needed zero changes to the vendored code. What cost time: (1) Aqua allocations are permissions, not reserved funds, so a static quote can be wrong once a shared wallet is spent in another market; we had to add an RPC balance refresh and full-route simulation, and this deserves a prominent section in the docs. (2) Aqua requires both tokens to be registered in a strategy even when one allocation is zero. (3) The canonical Sepolia Aqua address is the AquaRouter wrapper, whose runtime differs from the bare Aqua compiled locally; it took a Sourcify round-trip to be sure we were pointing at the right contract. (4) Arbitrary Shipped bytes are not a valid order, so indexers must reconstruct and hash the canonical order against the router; a reference Subgraph mapping for Shipped and Docked with canonical validation would help every Aqua app. (5) The default opcode dispatcher does not enable LimitSwap, which surprised us in the probe test. SwapVM relies on transient storage, so the Cancun requirement is worth stating up front.

Other relevant lines:
https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/contracts/src/ComplementaryExecutor.sol#L118
https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/contracts/src/RouteExecutor.sol#L72

## The Graph - Best AI Tooling or AI Use Case

How are you using this Protocol / API?

Field 1 - Why you are applicable for this prize:

Horizon's market data, trade routing and market creation all run on live Graph data. A Subgraph on Sepolia indexes MarketRegistry, Aqua Shipped and Docked events validated against the canonical HorizonSwapVM router, fills, collateral and resolutions; every quote reads its candidate curves from it, and the API keeps a PostgreSQL mirror that falls back to the indexer once it goes stale. Market drafting is grounded on that indexed set: the draft provider receives the current markets together with the indexed block number, duplicate warnings cite only real indexed market ids, and the API refuses to draft when the Subgraph is unavailable instead of assuming an empty market set. The provider interface is model-agnostic; the deployed instance runs the deterministic provider labelled development, and an Anthropic-backed provider grounded on the same live context is implemented behind a configuration flag. A Substreams package (horizon-events-v0.1.0.spkg) streams reorg-aware live updates from the chain into the UI. Deployed Subgraph: https://api.studio.thegraph.com/query/1758973/horizon/0.3.2

Field 2 - Link to the line of code:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/trading/graph.ts#L99

Field 3 - How easy is it to use (1-10):

7

Field 4 - Additional feedback for the Sponsor:

Subgraph authoring and Studio deploys were smooth. Three things bit us: (1) Studio query endpoints are capped at about 3,000 requests per day per version URL and GRAPH_API_KEY is silently ignored there because it only authenticates the decentralized gateway; we discovered this through a wall of 429s. Please document the cap and return a distinct error when a key is sent to Studio. (2) graph build accepted a manifest that mapped Docked to handleDock while the WASM did not export it; the subgraph deployed fine and then failed permanently at the first Docked event. A build-time check that every manifest handler exists in the WASM would have saved a version. (3) Free-tier indexing slots are shared across versions and old versions can only be archived from the web UI; a CLI or API for archiving would help. On Substreams: at the chain head a block arrives every twelve seconds or so and the HTTP/2 stream was dropped as idle, so we had to add keepalive pings on the Connect transport; a note in the @substreams/core docs would save others the same debugging.

Other relevant lines:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/creation/ai.ts#L57

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/subgraph/subgraph.yaml#L36

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/stream/substreams.ts#L58

## Hedera - AI and Agentic Payments

How are you using this Protocol / API?

Field 1 - Why you are applicable for this prize:

Market creation on Horizon is a paid service that both people and agents buy over x402 on Hedera testnet, settled through Blocky402. The API answers 402 with exact requirements in HBAR carrying a per-request nonce and the facilitator's advertised fee payer, the payer signs (a browser through Hedera WalletConnect, an agent with its own key, Horizon never sees either key), and the server verifies and settles only after checking the echoed requirements field by field. Payment is resumable and idempotent: one PaymentIntent per request, compare-and-set settlement, ambiguous facilitator results parked for reconciliation, so a retried request never charges twice and never creates two markets. Every approved draft, settled payment and deployed market is then published in order to Hedera Consensus Service topic 0.0.10473191 and read back from the mirror node. Live evidence: an agent-owned client paid 1 HBAR end to end, the resulting Sepolia market was created and indexed, and the audit trail on the topic verifies byte for byte against the mirror node.

Field 2 - Link to the line of code:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/payments/x402.ts#L85

Field 3 - How easy is it to use (1-10):

8

Field 4 - Additional feedback for the Sponsor:

The x402 plus Blocky402 path was the cleanest sponsor integration in the project: /supported advertising the fee payer, and verify then settle mapping directly onto our payment state machine. HCS through the JS SDK and the mirror node REST API were straightforward, and the mirror is fast enough to verify published statements byte for byte. Requests: (1) Blocky402 error bodies vary in shape; a stable contract such as code, reason and optional transactionId would make the ambiguous-versus-rejected classification deterministic. We currently treat any 5xx or transport failure as unknown and reconcile from the ledger. (2) A documented idempotency story for settle when the same payload is submitted twice; we built our own compare-and-set around it. (3) The Hedera WalletConnect partially-signed-transfer flow for x402 has few examples; a canonical sign-an-x402-exact-payment-in-the-browser snippet would help. (4) HCS setMaxChunks(1) as a guard was a nice primitive; reading a topic's submit key without fetching full topic info would be minor polish.

Other relevant lines:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/audit/hcs.ts#L91

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/web/src/hedera.ts#L34

https://hashscan.io/testnet/topic/0.0.10473191

## World - Selfie Check

How are you using this Protocol / API?

Field 1 - Why you are applicable for this prize:

A verified human pays half the market-creation price on Horizon. For each creation request the server mints an RP context with signRequest so the signing key never leaves the server, the client runs IDKit with the selfieCheckLegacy preset and the request id as signal, and the complete protocol 3.0 result is forwarded to /api/v4/verify/{rp_id} without remapping. Before contacting World the server re-checks action, environment and that signal_hash equals hashSignal(requestId), so a proof cannot be replayed onto another creation request. Only the nullifier is stored, and the discount is decided server-side when the x402 payment requirements are issued, bounded to one discounted creation per credential per UTC day. Selfie Check has been verified end to end in Sandbox against the production deployment, and a market creation was then paid at the discounted price over Hedera x402. Feedback on the credential integration, Developer Portal and Sandbox is in docs/WORLD_FEEDBACK.md.

Field 2 - Link to the line of code:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/world/verifier.ts#L49

Field 3 - How easy is it to use (1-10):

6

Field 4 - Additional feedback for the Sponsor:

Signal binding and nullifiers are exactly the right primitives, and forwarding the IDKit result verbatim made server validation trivial. Friction, detailed in docs/WORLD_FEEDBACK.md: (1) @worldcoin/idkit 4.2.3 exports three widgets and matching hooks and nothing says which one a Selfie Check integration should use; a decision table would have saved the most time of anything. (2) Server-side signRequest is reached through @worldcoin/idkit-core/signing, and a server importing a package named core made us double-check we were not bundling the signing key; a first-class server package in the docs would remove that doubt. (3) The SDK wants staging or production while the Portal says Sandbox; accept sandbox as an alias. (4) idkit_wasm_bg.wasm is about 870 kB (349 kB gzipped) for an optional flow, so we lazy-load the widget; a documented code-splitting recipe would help. (5) Access gating was the real blocker: the integration was complete and unit-tested for days while unprovable, so surfacing access state and expected turnaround in the Portal would change how teams plan. Please also state explicitly that the server must re-verify action, environment and signal_hash before trusting a result.

Other relevant lines:

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/src/creation/service.ts#L681

https://github.com/horizon-market/horizon/blob/859bd8c1c3212d3248608812cb62b66c5bc9ea18/docs/WORLD_FEEDBACK.md
