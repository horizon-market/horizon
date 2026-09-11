import type { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import { MarketService } from './trading/markets.js';
import { MarketProjectionStore, syncMarkets } from './trading/projection.js';
import { LiveStore } from './trading/overlay.js';
import { createDraftProvider } from './creation/ai.js';
import { createVerifier } from './world/verifier.js';
import { createFacilitator } from './payments/x402.js';
import { CreationService, WorkflowError } from './creation/service.js';
import { RegistryMarketDeployer } from './creation/onchain.js';
import { AdminService, ChainResolutionSubmitter } from './admin/service.js';
import { EventService } from './events/service.js';
import { AuditService } from './audit/service.js';
import { HcsAuditPublisher, MirrorNodeReader, UnconfiguredAuditPublisher } from './audit/hcs.js';
import { AUDIT_DELIVERY_NOTE, AUDIT_DISCLOSURE, AUDIT_SCHEMA, AUDIT_TYPES } from './audit/events.js';

export type QueueBindings = {
  enqueueCreation?: (requestId: string) => Promise<void>;
  enqueueResolution?: (resolutionId: string) => Promise<void>;
  enqueueAudit?: (requestId: string) => Promise<void>;
};

/** One wiring point for the API process, the worker process and integration tests. */
export function buildServices(config: Config, db: PrismaClient, queue: QueueBindings = {}) {
  // The mirror is only consulted when the sync is enabled; otherwise every read goes to The Graph.
  const projection = config.marketSync.enabled ? new MarketProjectionStore(db, config.marketSync.maxStalenessMs) : undefined;
  // The live layer is read whether or not a consumer is running: with none, there are no changes
  // newer than the snapshot and every read is exactly what it was before.
  const live = new LiveStore(db);
  const markets = config.trading ? new MarketService(config.trading, projection, live) : undefined;
  const provider = createDraftProvider(config.ai);
  const verifier = createVerifier(config.world);
  const facilitator = createFacilitator(config.payments);
  const deployer = config.creation ? new RegistryMarketDeployer(config.creation) : undefined;
  const submitter = config.creation ? new ChainResolutionSubmitter(config.creation) : undefined;
  const events = new EventService(db);
  // The trail is always recorded. Publication needs a topic and a signer; without them the outbox
  // simply accumulates, which is what makes a later `audit:backfill` possible rather than lost.
  const audit = new AuditService({
    db, config: config.audit, enqueue: queue.enqueueAudit,
    publisher: config.audit.enabled ? new HcsAuditPublisher(config.audit) : new UnconfiguredAuditPublisher(),
    mirror: new MirrorNodeReader(config.audit.mirrorNodeUrl),
  });
  const creation = new CreationService({
    db, provider, verifier, facilitator, payments: config.payments, world: config.world, deployer,
    imports: config.imports, enqueue: queue.enqueueCreation, audit, chainId: 11155111,
    closeBounds: { minSeconds: config.creation?.minCloseInSeconds ?? 3600, maxSeconds: config.creation?.maxCloseInSeconds ?? 365 * 24 * 3600 },
    // Drafting is grounded on live indexed markets; an indexer outage is reported, never assumed empty.
    context: async () => {
      if (!markets) return { available: false, context: { indexedBlock: -1, markets: [] } };
      try {
        const snapshot = await markets.graph.indexedMarkets();
        return { available: true, context: { indexedBlock: snapshot.block, markets: snapshot.markets.map(market => ({
          id: market.id, question: market.question, closeAt: new Date(market.closeAt * 1000).toISOString(), result: market.result })) } };
      } catch { throw new WorkflowError('market_context_unavailable', 503); }
    },
  });
  const admin = new AdminService({ db, markets, submitter, events, enqueueCreation: queue.enqueueCreation, enqueueResolution: queue.enqueueResolution });
  // Bound to the worker's sync job. The API process builds it too but never calls it.
  const syncProjection = markets && config.marketSync.enabled
    ? () => syncMarkets(db, markets.graph, { pageSize: config.marketSync.pageSize })
    : undefined;
  return { markets, creation, admin, events, audit, provider, verifier, facilitator, deployer, submitter, projection, live, syncProjection };
}

export function publicConfig(config: Config, services: ReturnType<typeof buildServices>) {
  return {
    chainId: 11155111,
    // Zero maker, taker, routing and protocol trading fees. The creation charge below is separate.
    fees: { maker: 0, taker: 0, routing: 0, protocol: 0, note: 'Horizon takes no trading fee. Network gas is separate.' },
    trading: config.trading ? { registry: config.trading.registry, router: config.trading.router, executor: config.trading.executor,
      aqua: config.trading.aqua, usdc: config.trading.usdc, decimals: 6, maxRouteFills: 4 } : null,
    creation: {
      available: Boolean(config.payments.payTo),
      priceUnits: config.payments.priceUnits.toString(), discountBps: config.payments.discountBps,
      asset: config.payments.asset === '0.0.0' ? 'HBAR' : config.payments.asset,
      assetId: config.payments.asset, assetDecimals: config.payments.assetDecimals, network: config.payments.network,
      settlementMode: config.payments.mode, facilitator: services.facilitator.name,
      walletConnectProjectId: config.payments.walletConnectProjectId ?? null,
      note: 'A one-off x402 charge for the market creation service. It is unrelated to trading, which has no fee.',
    },
    ai: { provider: services.provider.name, mode: services.provider.mode },
    // Live chain data. `reorg_aware` states the finality stance: a change is shown as soon as its
    // block is seen and withdrawn if the chain reverts it; nothing is presented as final earlier
    // than the stream's own final-block height.
    live: { available: config.stream.enabled, finality: 'reorg_aware',
      note: config.stream.enabled ? 'Markets, liquidity and trades update from the chain as blocks arrive; a reorg withdraws what it reverted.'
        : 'Live updates are not enabled; pages refresh from the periodic index.' },
    world: { available: services.verifier.available, widgetAvailable: services.verifier.available && Boolean(config.world.signingKey),
      access: config.world.access, reason: services.verifier.reason, action: config.world.action, appId: config.world.appId,
      rpId: config.world.rpId, environment: config.world.environment },
    resolution: { centralized: true, disclosed: true, resolver: services.submitter?.resolver ?? null,
      invalidPayout: '0.5 USDC per outcome token', note: 'A disclosed Horizon admin resolves markets to YES, NO or INVALID with an evidence reference.',
      // Stated where the application can read it, so no screen can imply a stronger guarantee.
      groupConsistency: 'backend_only',
      groupConsistencyNote: 'An event marked as exclusive is checked in the resolution workflow: a second YES is refused while a sibling is resolved YES or queued to be. '
        + 'The market contracts know nothing about events, so this is not enforced on chain.' },
    // The public audit trail. What it attests is stated where the application can read it, so no
    // screen can present it as verification of the payment, the deployment or a market outcome.
    audit: {
      // `configured`, not `publishing`: the API serves the trail and its links without holding the
      // audit signer, which in a split deployment lives only in the worker.
      available: services.audit.configured,
      schema: AUDIT_SCHEMA, types: [...AUDIT_TYPES],
      network: config.audit.network,
      topicId: services.audit.configured ? config.audit.topicId : null,
      topicUrl: services.audit.configured ? `${config.audit.explorerBase.replace(/\/$/, '')}/topic/${config.audit.topicId}` : null,
      mirrorNodeUrl: config.audit.mirrorNodeUrl,
      delivery: 'at_least_once', deliveryNote: AUDIT_DELIVERY_NOTE,
      // The reason only applies while there is no trail to read. With a topic configured this
      // process serves the trail; whether it can also sign is the worker's concern, not a warning.
      reason: services.audit.configured ? null : config.audit.reason, note: AUDIT_DISCLOSURE,
    },
    events: {
      // Grouping is service metadata. Every child is an independent binary market with its own
      // contracts, collateral and resolution; shared collateral and negative-risk conversion
      // between siblings are deliberately not implemented.
      available: true, sharedCollateral: false, negativeRiskConversion: false,
      imports: { available: config.imports.enabled, providers: config.imports.enabled ? ['polymarket'] : [],
        maxChildren: config.imports.maxChildren, policy: 'definitions_only',
        note: 'Imports copy definitions only: question, outcome labels, resolution criteria, evidence source and dates. Source prices, liquidity, volume and settlement never become Horizon data.' },
    },
  };
}
