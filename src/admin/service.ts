import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { PrismaClient } from '@prisma/client';
import type { CreationConfig } from '../config.js';
import { marketAbi } from '../trading/abi.js';
import { MarketService } from '../trading/markets.js';
import { WorkflowError } from '../creation/service.js';

export const RESOLUTIONS = { YES: 1, NO: 2, INVALID: 3 } as const;
export type ResolutionResult = keyof typeof RESOLUTIONS;
/** Disclosed centralized resolution for the MVP. INVALID pays 0.5 USDC per outcome token. */
const RESULT_NAMES = ['UNRESOLVED', 'YES', 'NO', 'INVALID'] as const;
export const PAYOUTS = { YES: '1 USDC per YES token, 0 per NO token', NO: '1 USDC per NO token, 0 per YES token', INVALID: '0.5 USDC per outcome token of either side' };

export interface ResolutionSubmitter {
  readonly resolver: Address;
  submit(market: Address, result: ResolutionResult, evidence: string): Promise<{ transactionHash?: Hex; alreadyResolved: boolean }>;
}

/** Only the disclosed resolver key can resolve, and only once per market. */
export class ChainResolutionSubmitter implements ResolutionSubmitter {
  readonly resolver: Address;
  private client;
  constructor(private config: CreationConfig) {
    this.resolver = config.resolver;
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpc, { timeout: 20_000, retryCount: 1 }) });
  }
  async submit(market: Address, result: ResolutionResult, evidence: string) {
    const current = await this.client.readContract({ address: market, abi: marketAbi, functionName: 'result' });
    if (current !== 0) return { alreadyResolved: true };
    if (!this.config.privateKey) throw new WorkflowError('resolver_key_not_configured', 503);
    const onChainResolver = await this.client.readContract({ address: market, abi: marketAbi, functionName: 'resolver' }) as Address;
    if (onChainResolver.toLowerCase() !== this.resolver.toLowerCase()) throw new WorkflowError('not_market_resolver', 403);
    const account = privateKeyToAccount(this.config.privateKey);
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(this.config.rpc, { retryCount: 0 }) });
    const args = [RESOLUTIONS[result], evidence] as const;
    await this.client.simulateContract({ address: market, abi: marketAbi, functionName: 'resolve', args, account });
    const hash = await wallet.writeContract({ address: market, abi: marketAbi, functionName: 'resolve', args });
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
    if (receipt.status !== 'success') throw new WorkflowError('resolution_transaction_reverted');
    return { transactionHash: receipt.transactionHash, alreadyResolved: false };
  }
}

export type AdminDependencies = {
  db: PrismaClient; markets?: MarketService; submitter?: ResolutionSubmitter;
  enqueueCreation?: (requestId: string) => Promise<void>;
  enqueueResolution?: (resolutionId: string) => Promise<void>;
};

export class AdminService {
  constructor(private deps: AdminDependencies) {}

  private async audit(actor: string, action: string, subject: string, detail?: object) {
    await this.deps.db.adminAudit.create({ data: { actor, action, subject, detail: detail ?? {} } });
  }

  async overview() {
    const db = this.deps.db;
    const [requests, payments, resolutions, jobs, statusCounts] = await Promise.all([
      db.creationRequest.findMany({ orderBy: { createdAt: 'desc' }, take: 25, include: { payment: true, verification: true } }),
      db.paymentIntent.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
      db.marketResolution.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
      db.jobRun.findMany({ orderBy: { completedAt: 'desc' }, take: 25 }),
      db.creationRequest.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    let markets: unknown[] = [], awaitingResolution: unknown[] = [], marketsError: string | undefined;
    if (this.deps.markets) {
      try {
        const listed = await this.deps.markets.list();
        const now = Math.floor(Date.now() / 1000);
        // Every market is listed so an operator can inspect and resolve any of them. The market
        // contract refuses resolution before its close timestamp, so that is reported per row.
        markets = listed.markets.map(market => ({
          market: market.id, question: market.question, closeAt: market.closeAt, status: market.status,
          result: RESULT_NAMES[market.result], resolver: market.resolver, rules: market.rules,
          evidenceSource: market.evidenceSource, collateral: market.collateral.toString(),
          resolutionEvidence: market.resolutionEvidence, curves: market.liquidity.curves,
          resolvable: market.result === 0 && market.closeAt <= now,
        }));
        awaitingResolution = (markets as { resolvable: boolean }[]).filter(market => market.resolvable);
      } catch { marketsError = 'graph_unavailable'; }
    } else marketsError = 'trading_not_configured';
    return {
      counts: Object.fromEntries(statusCounts.map(entry => [entry.status, entry._count._all])),
      requests: requests.map(request => ({
        id: request.id, status: request.status, question: request.question, requesterKind: request.requesterKind,
        requester: request.requester, draftProvider: request.draftProvider, draftMode: request.draftMode,
        discountBps: request.discountBps, discountNote: request.discountNote, priceUnits: request.priceUnits,
        marketAddress: request.marketAddress, creationTxHash: request.creationTxHash, failureCode: request.failureCode,
        attempts: request.attempts, createdAt: request.createdAt,
        verified: Boolean(request.verification), paymentStatus: request.payment?.status ?? null,
      })),
      payments, resolutions, jobs, markets, awaitingResolution, marketsError,
      resolverModel: { centralized: true, disclosed: true, resolver: this.deps.submitter?.resolver ?? null, payouts: PAYOUTS },
    };
  }

  async retryCreation(actor: string, requestId: string) {
    const request = await this.deps.db.creationRequest.findUnique({ where: { id: requestId }, include: { payment: true } });
    if (!request) throw new WorkflowError('unknown_request', 404);
    if (request.payment?.status !== 'SETTLED') throw new WorkflowError('creation_before_settlement');
    if (!['PAID', 'FAILED'].includes(request.status)) throw new WorkflowError('creation_not_retryable');
    if (!this.deps.enqueueCreation) throw new WorkflowError('queue_not_configured', 503);
    await this.deps.enqueueCreation(requestId);
    await this.audit(actor, 'creation.retry', requestId, { status: request.status });
    return { requestId, enqueued: true };
  }

  /**
   * Records a reconciled payment outcome. Reconciliation is a deliberate human decision about an
   * ambiguous settlement, evidenced by a facilitator or ledger reference; it never charges again.
   */
  async reconcilePayment(actor: string, paymentId: string, outcome: 'SETTLED' | 'FAILED', reference: string) {
    const payment = await this.deps.db.paymentIntent.findUnique({ where: { id: paymentId } });
    if (!payment) throw new WorkflowError('unknown_payment', 404);
    if (!['REVIEW', 'SUBMITTED'].includes(payment.status)) throw new WorkflowError('payment_not_in_review');
    const updated = await this.deps.db.$transaction(async tx => {
      const result = await tx.paymentIntent.update({
        where: { id: paymentId },
        data: outcome === 'SETTLED'
          ? { status: 'SETTLED', transactionRef: reference, settledAt: new Date(), failureCode: null }
          : { status: 'FAILED', failureCode: `reconciled_failed:${reference}`.slice(0, 200) },
      });
      await tx.creationRequest.update({ where: { id: payment.requestId }, data: { status: outcome === 'SETTLED' ? 'PAID' : 'PAYMENT_REQUIRED' } });
      return result;
    });
    await this.audit(actor, 'payment.reconcile', paymentId, { outcome, reference });
    if (outcome === 'SETTLED') await this.deps.enqueueCreation?.(payment.requestId).catch(() => undefined);
    return updated;
  }

  /**
   * Reads published curves, their individual fills and the taker routes, for one market or for
   * all of them. This is indexed history; settlement remains authoritative on chain.
   */
  async activity(market?: Address) {
    if (!this.deps.markets) throw new WorkflowError('trading_not_configured', 503);
    const indexed = await this.deps.markets.graph.activity(market);
    return { indexedBlock: indexed.block, market: market ?? null,
      curves: indexed.curves.map(curve => ({ ...curve, side: curve.flags & 1 ? 'YES' : 'NO',
        direction: curve.flags & 2 ? 'BUY' : 'SELL', shape: curve.flags >> 2,
        remaining: (curve.maxShares > curve.filled ? curve.maxShares - curve.filled : 0n).toString(),
        maxShares: curve.maxShares.toString(), filled: curve.filled.toString() })),
      fills: indexed.fills.map(fill => ({ ...fill, side: fill.flags & 1 ? 'YES' : 'NO',
        direction: fill.flags & 2 ? 'BUY' : 'SELL', shares: fill.shares.toString(), usdc: fill.usdc.toString() })),
      routes: indexed.routes.map(route => ({ ...route, shares: route.shares.toString(), usdc: route.usdc.toString() })),
      fees: { maker: 0, taker: 0, routing: 0, protocol: 0 } };
  }

  async requestResolution(actor: string, market: Address, result: ResolutionResult, evidence: string) {
    // Refuse before the market's own close time rather than queueing a job the contract rejects.
    if (this.deps.markets) {
      const detail = await this.deps.markets.detail(market);
      if (detail.market.result !== 0) throw new WorkflowError('market_already_resolved');
      if (detail.market.status === 'OPEN') throw new WorkflowError('market_not_closed_yet', 422);
    }
    const record = await this.deps.db.marketResolution.upsert({
      where: { market: market.toLowerCase() },
      create: { market: market.toLowerCase(), result, evidence, requestedBy: actor, status: 'PENDING' },
      update: {},
    });
    if (record.status === 'SUBMITTED') throw new WorkflowError('market_already_resolved');
    await this.audit(actor, 'market.resolve', market, { result, evidence });
    if (!this.deps.enqueueResolution) throw new WorkflowError('queue_not_configured', 503);
    await this.deps.enqueueResolution(record.id);
    return record;
  }

  /** Runs one recorded resolution. Re-running after a failure re-checks the on-chain result first. */
  async runResolution(id: string) {
    const record = await this.deps.db.marketResolution.findUnique({ where: { id } });
    if (!record) throw new WorkflowError('unknown_resolution', 404);
    if (record.status === 'SUBMITTED') return record;
    if (!this.deps.submitter) throw new WorkflowError('resolver_not_configured', 503);
    await this.deps.db.marketResolution.update({ where: { id }, data: { status: 'RUNNING', attempts: { increment: 1 }, failureCode: null } });
    try {
      const outcome = await this.deps.submitter.submit(record.market as Address, record.result as ResolutionResult, record.evidence);
      return await this.deps.db.marketResolution.update({ where: { id }, data: { status: 'SUBMITTED', txHash: outcome.transactionHash ?? record.txHash } });
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 120) : 'resolution_failed';
      await this.deps.db.marketResolution.update({ where: { id }, data: { status: 'FAILED', failureCode: code } });
      throw error;
    }
  }
}
