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

export type Config = z.infer<typeof schema> & {
  trading?: TradingConfig; creation?: CreationConfig; payments: PaymentsConfig; world: WorldConfig; ai: AiConfig;
  marketSync: MarketSyncConfig;
};

const positiveInteger = (value: string | undefined, fallback: bigint) => {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,20}$/.test(value)) throw new Error('Invalid configuration: CREATION_PRICE_UNITS');
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error('Invalid configuration: CREATION_PRICE_UNITS');
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
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
  const config: Config = {
    ...result.data,
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
