import { z } from 'zod';

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

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never print the input object: it contains database credentials and secrets.
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}. See .env.example.`);
  }
  return result.data;
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL;
  if (!value || !/^postgres(ql)?:\/\//.test(value)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  return value;
}
