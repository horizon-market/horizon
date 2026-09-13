# World integration feedback

Feedback from integrating World Selfie Check into Horizon's market-creation flow, where a
verified human pays a lower creation price.

**Status, stated plainly:** the integration is fully implemented and tested. Access was granted
late in the hackathon (September 12, 2026); a credential has been verified in Sandbox against the
production deployment and a creation was then paid at the discounted 0.5 HBAR price over Hedera
x402. Everything below that describes SDK and API behaviour is drawn from the code we wrote
against `@worldcoin/idkit` and `@worldcoin/idkit-core` **4.2.3** and can be checked in this
repository. The section *Not yet captured* lists the Sandbox observations we have not written up
rather than guessing at them.

## What we built

- A per-request RP context. `POST /api/creation/requests/:id/world/rp-context` mints one with
  `signRequest({ signingKeyHex, action, ttl: 300 })`. The RP signing key never leaves the server.
- The widget runs client-side with `preset: selfieCheckLegacy({ signal: requestId })` and the
  server-minted `rp_context`.
- The complete IDKit result is posted back to the API and forwarded to World **without field
  remapping**, against `POST /api/v4/verify/{rp_id}`.
- Before contacting World, the server rejects a proof whose `action` or `environment` does not
  match the deployment, or whose `signal_hash` is not `hashSignal(requestId)`. A credential proved
  for one creation request therefore cannot be replayed onto another.
- Only the **nullifier hash and identifier** are persisted. No image, document, raw proof or
  Merkle root is stored.
- The discount is bounded to one creation per credential per UTC day, and is decided server-side
  when the x402 payment requirements are issued — never from a client-side claim.

Relevant code: `src/world/verifier.ts`, `src/creation/service.ts`,
`web/src/components/WorldVerification.tsx`, tests in `test/creation.test.ts`.

## What worked well

- **Signal binding is the right primitive.** `hashSignal` plus a server-side comparison gave us
  replay protection between creation requests with no extra protocol design on our side.
- **RP request signing keeps the secret server-side.** `signRequest` returning
  `{ nonce, createdAt, expiresAt, sig }` mapped cleanly onto a short-lived, per-request endpoint.
- **Forwarding the result verbatim is a good default.** Once we stopped reshaping the object and
  passed the whole protocol-3.0 result through, the server-side contract became trivial to
  validate with a schema.
- **Nullifiers make bounded entitlements easy.** One discounted creation per credential per UTC
  day was a unique index and nothing more.

## Friction we hit

1. **Choosing an entry point is not obvious.** `@worldcoin/idkit` 4.2.3 exports
   `IDKitRequestWidget`, `IDKitInviteCodeRequestWidget` and `IDKitSessionWidget` (plus matching
   hooks). Nothing in the type surface says which one a Selfie Check integration should use, and
   the names imply access-model differences rather than UI differences. A short decision table in
   the docs would have saved us the most time of anything here.
2. **Server signing is re-exported through a client package.** `signRequest` lives in
   `@worldcoin/idkit-server` but we reach it via `@worldcoin/idkit-core/signing`. That works, but
   it means a *server* imports a package named `idkit-core`, and it took a while to be confident
   we were not shipping a signing key into a bundle. A first-class server package in the docs
   would remove that doubt.
3. **`environment` naming does not match the Portal.** The SDK takes `staging` or `production`
   while the Portal presents "Sandbox". Our configuration accepts the Portal's word and maps it,
   but a builder copying the Portal value straight into the SDK gets a value the types reject.
4. **The WASM payload is heavy for a conditional flow.** `idkit_wasm_bg.wasm` is ~870 kB
   (~349 kB gzipped) in our production build. Verification is optional and most visitors never
   start it, so we had to lazy-load the widget behind a dynamic import to keep the initial bundle
   reasonable. A documented code-splitting recipe would help.
5. **Access gating blocks the last mile.** This is the significant one. The entire path —
   RP context, widget, signal binding, server verification, nullifier storage, discount accounting
   — is implemented and unit-tested, and cannot be exercised end to end because Selfie Check
   access has not been granted. From a builder's perspective the integration looks finished and is
   simultaneously unprovable, which is an uncomfortable place to be before a submission deadline.
   Clearer, faster signalling of access state and expected turnaround would change how we plan.

## Suggestions

- Publish a one-page "Selfie Check from scratch" path: which widget, which preset, where the
  signal goes, what the server must re-check, and what to store.
- State explicitly that the server should re-verify `action`, `environment` and `signal_hash`
  before trusting a result. We chose to; it was not spelled out for us.
- Align the `environment` vocabulary between Portal and SDK, or accept `sandbox` as an alias.
- Document the recommended lazy-loading pattern and the WASM size implication.
- Surface access status and its expected timeline in the Portal.

## Not yet captured

Access arrived on the last day, so these were not written up systematically and are left blank
rather than invented:

- Developer Portal walkthrough: app and action creation, RP key issuance, and anything surprising.
- Exact Sandbox error strings for a wrong action, an expired RP signature and a reused nullifier,
  and whether they are actionable.
- Observed latency and drop-off of the Selfie Check capture itself.
- The verified-versus-standard payment requirement, captured side by side. The API emits both and
  the discounted requirement has been paid once; the two 402 bodies are not yet recorded here.

## Reproducing the current state

```sh
npm run doctor        # reports World as pending until the discounted transaction id is recorded
npm test              # includes the action, environment and signal-binding rejection tests
```

With `WORLD_SELFIE_ACCESS=granted` and `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY` and `WORLD_ACTION`
set, `/api/config` reports `world.widgetAvailable: true` and the creation flow shows the widget
instead of the unavailable notice. No other code change is required.
