import PgBoss from 'pg-boss';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const PROBE_QUEUE = 'system.probe';
export const probeSchema = z.object({ probeId: z.string().uuid(), label: z.string().min(1).max(120) });
export type ProbeData = z.infer<typeof probeSchema>;

export async function startQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'horizon-queue' });
  boss.on('error', () => console.error('Queue error; check database availability'));
  await boss.start();
  await boss.createQueue(PROBE_QUEUE, { name: PROBE_QUEUE, retryLimit: 3, retryDelay: 1, retryBackoff: true, expireInSeconds: 60 });
  return boss;
}

export async function enqueueProbe(boss: PgBoss, data: ProbeData): Promise<string> {
  const id = await boss.send(PROBE_QUEUE, probeSchema.parse(data));
  if (!id) throw new Error('Diagnostic job was not enqueued');
  return id;
}

export async function recordProbe(db: PrismaClient, queueJobId: string, input: unknown): Promise<void> {
  const data = probeSchema.parse(input);
  // The business identifier survives retries, duplicate deliveries and process restarts.
  // Later external-side-effect handlers must additionally reconcile transaction receipts.
  await db.jobRun.upsert({
    where: { id: data.probeId },
    create: { id: data.probeId, queueJobId, label: data.label },
    update: {},
  });
}

export async function registerWorker(boss: PgBoss, db: PrismaClient): Promise<void> {
  await boss.work<ProbeData>(PROBE_QUEUE, { pollingIntervalSeconds: 1 }, async jobs => {
    for (const job of jobs) await recordProbe(db, job.id, job.data);
  });
}
