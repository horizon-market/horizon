import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { registryAbi } from '../trading/abi.js';
import type { CreationConfig } from '../config.js';

export class OnChainCreationError extends Error {}
const ZERO = '0x0000000000000000000000000000000000000000';

/** A stable identifier derived from the durable request id makes creation idempotent on-chain. */
export function creationId(requestId: string): Hex {
  return keccak256(toHex(`horizon-creation:${requestId}`));
}

export type MarketPlan = { requestId: string; question: string; rules: string; evidenceSource: string; closeAt: number };

export interface MarketDeployer {
  readonly resolver: Address;
  find(requestId: string): Promise<Address | undefined>;
  create(plan: MarketPlan): Promise<{ market: Address; transactionHash?: Hex; alreadyExisted: boolean }>;
}

/**
 * Registry-owner deployment. The key lives only in the API/worker process. Every attempt first
 * checks the registry for the request's creation id, so a retry after a failed or ambiguous
 * broadcast records the existing market instead of creating a second one.
 */
export class RegistryMarketDeployer implements MarketDeployer {
  readonly resolver: Address;
  private client;
  constructor(private config: CreationConfig) {
    this.resolver = config.resolver;
    this.client = createPublicClient({ chain: sepolia, transport: http(config.rpc, { timeout: 20_000, retryCount: 1 }) });
  }
  async find(requestId: string): Promise<Address | undefined> {
    const market = await this.client.readContract({ address: this.config.registry, abi: registryAbi, functionName: 'marketByCreationId', args: [creationId(requestId)] }) as Address;
    return market === ZERO ? undefined : market;
  }
  async create(plan: MarketPlan) {
    const existing = await this.find(plan.requestId);
    if (existing) return { market: existing, alreadyExisted: true };
    if (!this.config.privateKey) throw new OnChainCreationError('creation_key_not_configured');
    const now = Math.floor(Date.now() / 1000);
    if (plan.closeAt <= now + this.config.minCloseInSeconds || plan.closeAt > now + this.config.maxCloseInSeconds) throw new OnChainCreationError('invalid_close_time');
    if (await this.client.getChainId() !== 11155111) throw new OnChainCreationError('wrong_chain');
    const account = privateKeyToAccount(this.config.privateKey);
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(this.config.rpc, { retryCount: 0 }) });
    const args = [creationId(plan.requestId), plan.question, plan.rules, plan.evidenceSource, plan.closeAt, this.resolver] as const;
    await this.client.simulateContract({ address: this.config.registry, abi: registryAbi, functionName: 'createMarket', args, account });
    const hash = await wallet.writeContract({ address: this.config.registry, abi: registryAbi, functionName: 'createMarket', args });
    const receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
    if (receipt.status !== 'success') throw new OnChainCreationError('creation_transaction_reverted');
    const market = await this.find(plan.requestId);
    if (!market) throw new OnChainCreationError('creation_not_recorded');
    return { market, transactionHash: receipt.transactionHash, alreadyExisted: false };
  }
}
