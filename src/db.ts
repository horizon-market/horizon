import { PrismaClient } from '@prisma/client';

export function createDatabase(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}
