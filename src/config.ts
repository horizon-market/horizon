import { z } from 'zod';
import type { TradingConfig } from './trading/service.js';
import type { Address, Hex } from 'viem';

/** An unset key and an empty key mean the same thing in a .env file: take the default. */
const blank = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(value => value === '' ? undefined : value, inner);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
  SESSION_SECRET: z.string().min(32),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  WEB_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  // Market mirror. The sync worker refreshes on this interval; reads fall back to The Graph once
  // the mirror is older than the staleness budget, so these two together bound how wrong a page
  // can be before correctness is handed back to the indexer.
  MARKET_SYNC_ENABLED: blank(z.enum(['true', 'false']).default('true').transform(value => value === 'true')),
  MARKET_SYNC_INTERVAL_MS: blank(z.coerce.number().int().min(2_000).max(600_000).default(15_000)),
  MARKET_SYNC_MAX_STALENESS_MS: blank(z.coerce.number().int().min(5_000).max(3_600_000).default(120_000)),
  MARKET_SYNC_PAGE_SIZE: blank(z.coerce.number().int().min(10).max(1_000).default(200)),
});

/** Hedera x402 charge for the creation service only. It is unrelated to trading, which has no fee. */
export type PaymentsConfig = {
  facilitatorUrl: string; network: string; payTo: string; asset: string; assetDecimals: number;
  mode: 'live' | 'simulated'; priceUnits: bigint; discountBps: number; timeoutSeconds: number; walletConnectProjectId?: string;
};
/** World access is an administrative declaration; only `granted` may attempt a live verification. */
export type WorldConfig = { appId: string; rpId: string; signingKey?: string; action: string; environment: 'sandbox' | 'staging' | 'production'; access: 'unknown' | 'requested' | 'granted'; verifyUrl: string };
export type AiConfig = { provider: 'anthropic' | 'development'; apiKey?: string; model: string };
/** Server-side market deployment. The key stays in the API/worker process and never reaches a browser. */
export type CreationConfig = { rpc: string; registry: Address; resolver: Address; privateKey?: Hex; minCloseInSeconds: number; maxCloseInSeconds: number };

export type MarketSyncConfig = { enabled: boolean; intervalMs: number; maxStalenessMs: number; pageSize: number };
/**
 * Public audit trail on the Hedera Consensus Service. The signer is a dedicated server-side
 * account whose key is the topic's submit key, so only this service can append to the trail; it
 * is unrelated to the x402 payer and to the Sepolia deployer, and never reaches a browser.
 */
export type AuditConfig = {
  /** Whether a submission can actually be made. The outbox records statements either way. */
  enabled: boolean;
  /** Why publication is off, when it is. Names settings only, never a value. */
  reason: string;
  network: 'testnet' | 'previewnet' | 'mainnet' | 'local-node';
  topicId: string;
  operatorId: string;
  operatorKey?: string;
  keyType: 'der' | 'ecdsa' | 'ed25519';
  mirrorNodeUrl: string;
  explorerBase: string;
  publishIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  requestTimeoutMs: number;
};
/**
 * Definition imports. The API origin is fixed configuration, never something a request supplies:
 * a user pastes a Polymarket page address and the backend fetches from this origin only.
 */
export type ImportsConfig = { enabled: boolean; polymarketApiOrigin: string; timeoutMs: number; maxChildren: number };

export type Config = z.infer<typeof schema> & {
  trading?: TradingConfig; creation?: CreationConfig; payments: PaymentsConfig; world: WorldConfig; ai: AiConfig;
  marketSync: MarketSyncConfig; imports: ImportsConfig; audit: AuditConfig;
};

const HEDERA_NETWORKS = ['testnet', 'previewnet', 'mainnet', 'local-node'] as const;
const MIRROR_NODES: Record<string, string> = {
  testnet: 'https://testnet.mirrornode.hedera.com',
  previewnet: 'https://previewnet.mirrornode.hedera.com',
  mainnet: 'https://mainnet-public.mirrornode.hedera.com',
  'local-node': 'http://127.0.0.1:5551',
};
const accountId = /^\d{1,10}\.\d{1,10}\.\d{1,12}$/;

function auditConfig(env: NodeJS.ProcessEnv): AuditConfig {
  // `hedera:testnet` is the x402 network name the payment path already uses; the SDK names the
  // same network `testnet`. One setting derives from the other so they cannot drift apart.
  const declared = env.HEDERA_AUDIT_NETWORK || (env.HEDERA_NETWORK || 'hedera:testnet').split(':').pop() || 'testnet';
  if (!(HEDERA_NETWORKS as readonly string[]).includes(declared)) throw new Error('Invalid configuration: HEDERA_AUDIT_NETWORK');
  const network = declared as AuditConfig['network'];
  const topicId = (env.HEDERA_AUDIT_TOPIC_ID ?? '').trim();
  const operatorId = (env.HEDERA_AUDIT_ACCOUNT_ID ?? '').trim();
  const operatorKey = env.HEDERA_AUDIT_PRIVATE_KEY?.trim() || undefined;
  if (topicId && !accountId.test(topicId)) throw new Error('Invalid configuration: HEDERA_AUDIT_TOPIC_ID');
  if (operatorId && !accountId.test(operatorId)) throw new Error('Invalid configuration: HEDERA_AUDIT_ACCOUNT_ID');
  const keyType = ['der', 'ecdsa', 'ed25519'].includes(env.HEDERA_AUDIT_KEY_TYPE ?? '')
    ? env.HEDERA_AUDIT_KEY_TYPE as AuditConfig['keyType'] : 'ecdsa';
  const turnedOff = env.HEDERA_AUDIT_ENABLED === 'false';
  const missing = [
    !topicId && 'HEDERA_AUDIT_TOPIC_ID', !operatorId && 'HEDERA_AUDIT_ACCOUNT_ID', !operatorKey && 'HEDERA_AUDIT_PRIVATE_KEY',
  ].filter(Boolean);
  const enabled = !turnedOff && missing.length === 0;
  const reason = turnedOff ? 'Publication is disabled by HEDERA_AUDIT_ENABLED=false; statements are still recorded.'
    : missing.length ? `Publication is not configured: set ${missing.join(', ')}. Statements are still recorded and can be published later.`
      : 'Configured.';
  const interval = Number(env.HEDERA_AUDIT_PUBLISH_INTERVAL_MS ?? '20000');
  if (!Number.isInteger(interval) || interval < 2_000 || interval > 600_000) throw new Error('Invalid configuration: HEDERA_AUDIT_PUBLISH_INTERVAL_MS');
  return {
    enabled, reason, network, topicId, operatorId, operatorKey, keyType,
    mirrorNodeUrl: env.HEDERA_MIRROR_NODE_URL || MIRROR_NODES[network]!,
    explorerBase: env.HEDERA_EXPLORER_BASE || `https://hashscan.io/${network}`,
    publishIntervalMs: interval, maxAttempts: 8, retryBaseMs: 5_000, retryMaxMs: 300_000, requestTimeoutMs: 30_000,
  };
}

const positiveInteger = (value: string | undefined, fallback: bigint) => {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,20}$/.test(value)) throw new Error('Invalid configuration: CREATION_PRICE_UNITS');
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error('Invalid configuration: CREATION_PRICE_UNITS');
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Production platforms such as Railway inject environment variables without creating a .env
  // file and route traffic to the container over its network interface. Keep local development
  // bound to loopback, but make the production default reachable without provider-specific config.
  const input = env.HOST || env.NODE_ENV !== 'production' ? env : { ...env, HOST: '0.0.0.0' };
  const result = schema.safeParse(input);
  if (!result.success) {
    // Never print the input object: it contains database credentials and secrets.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  }
  const discountBps = Number(env.CREATION_DISCOUNT_BPS ?? '5000');
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) throw new Error('Invalid configuration: CREATION_DISCOUNT_BPS');
  const assetDecimals = Number(env.HEDERA_ASSET_DECIMALS ?? '8');
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 18) throw new Error('Invalid configuration: HEDERA_ASSET_DECIMALS');
  const mode = env.HEDERA_PAYMENT_MODE === 'simulated' ? 'simulated' : 'live';
  const access = ['unknown', 'requested', 'granted'].includes(env.WORLD_SELFIE_ACCESS ?? '') ? env.WORLD_SELFIE_ACCESS as WorldConfig['access'] : 'unknown';
  const worldEnvironment = ['sandbox', 'staging', 'production'].includes(env.WORLD_ENVIRONMENT ?? '')
    ? env.WORLD_ENVIRONMENT as WorldConfig['environment'] : 'sandbox';
  const importOrigin = env.POLYMARKET_API_ORIGIN || 'https://gamma-api.polymarket.com';
  try {
    const parsed = new URL(importOrigin);
    if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('insecure');
  } catch { throw new Error('Invalid configuration: POLYMARKET_API_ORIGIN'); }
  const maxImportChildren = Number(env.IMPORT_MAX_CHILDREN ?? '24');
  if (!Number.isInteger(maxImportChildren) || maxImportChildren < 1 || maxImportChildren > 24) throw new Error('Invalid configuration: IMPORT_MAX_CHILDREN');
  const config: Config = {
    ...result.data,
    imports: {
      enabled: env.IMPORTS_ENABLED !== 'false',
      polymarketApiOrigin: importOrigin, timeoutMs: 12_000, maxChildren: maxImportChildren,
    },
    marketSync: {
      enabled: result.data.MARKET_SYNC_ENABLED, intervalMs: result.data.MARKET_SYNC_INTERVAL_MS,
      maxStalenessMs: result.data.MARKET_SYNC_MAX_STALENESS_MS, pageSize: result.data.MARKET_SYNC_PAGE_SIZE,
    },
    payments: {
      facilitatorUrl: env.HEDERA_FACILITATOR_URL || 'https://api.testnet.blocky402.com',
      network: env.HEDERA_NETWORK || 'hedera:testnet',
      payTo: env.HEDERA_RECEIVER_ACCOUNT_ID ?? '',
      asset: env.HEDERA_ASSET_ID || '0.0.0',
      assetDecimals, mode,
      priceUnits: positiveInteger(env.CREATION_PRICE_UNITS, 100_000_000n),
      discountBps, timeoutSeconds: 300, walletConnectProjectId: env.HEDERA_WALLETCONNECT_PROJECT_ID || undefined,
    },
    world: {
      appId: env.WORLD_APP_ID ?? '', rpId: env.WORLD_RP_ID ?? '', signingKey: env.WORLD_RP_SIGNING_KEY || undefined,
      action: env.WORLD_ACTION ?? '', environment: worldEnvironment,
      access, verifyUrl: env.WORLD_VERIFY_URL || 'https://developer.world.org',
    },
    audit: auditConfig(env),
    ai: {
      provider: env.AI_PROVIDER === 'anthropic' || (env.AI_PROVIDER !== 'development' && env.ANTHROPIC_API_KEY) ? 'anthropic' : 'development',
      apiKey: env.ANTHROPIC_API_KEY || undefined, model: env.ANTHROPIC_MODEL || 'claude-opus-5',
    },
  };
  const keys = ['EVM_RPC_URL', 'GRAPH_QUERY_URL', 'HORIZON_ROUTER_ADDRESS', 'HORIZON_EXECUTOR_ADDRESS', 'HORIZON_REGISTRY_ADDRESS', 'AQUA_ADDRESS', 'USDC_ADDRESS'] as const;
  if (keys.every(key => env[key])) {
    for (const key of keys.filter(key => key.endsWith('ADDRESS'))) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(env[key]!)) throw new Error(`Invalid configuration: ${key}`);
    }
    config.trading = { rpc: env.EVM_RPC_URL!, graph: env.GRAPH_QUERY_URL!, graphKey: env.GRAPH_API_KEY,
      router: env.HORIZON_ROUTER_ADDRESS as Address, executor: env.HORIZON_EXECUTOR_ADDRESS as Address,
      registry: env.HORIZON_REGISTRY_ADDRESS as Address, aqua: env.AQUA_ADDRESS as Address, usdc: env.USDC_ADDRESS as Address };
  }
  if (env.EVM_RPC_URL && env.HORIZON_REGISTRY_ADDRESS && env.EVM_DEPLOYER_ADDRESS) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.EVM_DEPLOYER_ADDRESS)) throw new Error('Invalid configuration: EVM_DEPLOYER_ADDRESS');
    const raw = env.EVM_DEPLOYER_PRIVATE_KEY;
    config.creation = {
      rpc: env.EVM_RPC_URL, registry: env.HORIZON_REGISTRY_ADDRESS as Address, resolver: env.EVM_DEPLOYER_ADDRESS as Address,
      privateKey: raw ? ((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex) : undefined,
      minCloseInSeconds: 3600, maxCloseInSeconds: 365 * 24 * 3600,
    };
  }
  return config;
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL;
  if (!value || !/^postgres(ql)?:\/\//.test(value)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  return value;
}
