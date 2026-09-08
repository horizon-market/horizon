import { z } from 'zod';
import type { TradingConfig } from './trading/service.js';
import type { Address } from 'viem';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
  SESSION_SECRET: z.string().min(32),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export type Config = z.infer<typeof schema> & { trading?: TradingConfig };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never print the input object: it contains database credentials and secrets.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  }
  const config: Config = result.data;
  const keys = ['EVM_RPC_URL', 'GRAPH_QUERY_URL', 'HORIZON_ROUTER_ADDRESS', 'HORIZON_EXECUTOR_ADDRESS', 'HORIZON_REGISTRY_ADDRESS', 'AQUA_ADDRESS', 'USDC_ADDRESS'] as const;
  if (keys.every(key => env[key])) {
    for (const key of keys.filter(key => key.endsWith('ADDRESS'))) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(env[key]!)) throw new Error(`Invalid configuration: ${key}`);
    }
    config.trading = { rpc: env.EVM_RPC_URL!, graph: env.GRAPH_QUERY_URL!, graphKey: env.GRAPH_API_KEY,
      router: env.HORIZON_ROUTER_ADDRESS as Address, executor: env.HORIZON_EXECUTOR_ADDRESS as Address,
      registry: env.HORIZON_REGISTRY_ADDRESS as Address, aqua: env.AQUA_ADDRESS as Address, usdc: env.USDC_ADDRESS as Address };
  }
  return config;
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL;
  if (!value || !/^postgres(ql)?:\/\//.test(value)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  return value;
}
