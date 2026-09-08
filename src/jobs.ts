import PgBoss from 'pg-boss';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const PROBE_QUEUE = 'system.probe';
export const CREATION_QUEUE = 'creation.market';
export const RESOLUTION_QUEUE = 'market.resolution';
export const probeSchema = z.object({ probeId: z.string().uuid(), label: z.string().min(1).max(120) });
export const creationJobSchema = z.object({ requestId: z.string().uuid() });
export const resolutionJobSchema = z.object({ resolutionId: z.string().uuid() });
export type ProbeData = z.infer<typeof probeSchema>;
export type CreationJobData = z.infer<typeof creationJobSchema>;
export type ResolutionJobData = z.infer<typeof resolutionJobSchema>;

const RETRY = { retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 600 };

export async function startQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'horizon-queue' });
  boss.on('error', () => console.error('Queue error; check database availability'));
  await boss.start();
  await boss.createQueue(PROBE_QUEUE, { name: PROBE_QUEUE, retryLimit: 3, retryDelay: 1, retryBackoff: true, expireInSeconds: 60 });
  await boss.createQueue(CREATION_QUEUE, { name: CREATION_QUEUE, ...RETRY });
  await boss.createQueue(RESOLUTION_QUEUE, { name: RESOLUTION_QUEUE, ...RETRY });
  return boss;
}

export async function enqueueProbe(boss: PgBoss, data: ProbeData): Promise<string> {
  const id = await boss.send(PROBE_QUEUE, probeSchema.parse(data));
  if (!id) throw new Error('Diagnostic job was not enqueued');
  return id;
}

/** Deduplicated by business id: a retried API call cannot queue a second creation for one request. */
export async function enqueueCreation(boss: PgBoss, requestId: string): Promise<void> {
  await boss.send(CREATION_QUEUE, creationJobSchema.parse({ requestId }), { singletonKey: requestId, ...RETRY });
}
export async function enqueueResolution(boss: PgBoss, resolutionId: string): Promise<void> {
  await boss.send(RESOLUTION_QUEUE, resolutionJobSchema.parse({ resolutionId }), { singletonKey: resolutionId, ...RETRY });
}

export async function recordProbe(db: PrismaClient, queueJobId: string, input: unknown): Promise<void> {
  const data = probeSchema.parse(input);
  // The business identifier survives retries, duplicate deliveries and process restarts.
  // Handlers with external side effects must additionally reconcile transaction receipts.
  await db.jobRun.upsert({
    where: { id: data.probeId },
    create: { id: data.probeId, queueJobId, label: data.label },
    update: {},
  });
}

/** Observable job status: the latest outcome per business id, alongside the workflow row itself. */
export async function recordRun(db: PrismaClient, id: string, queueJobId: string, label: string): Promise<void> {
  await db.jobRun.upsert({
    where: { id }, create: { id, queueJobId, label: label.slice(0, 120) },
    update: { label: label.slice(0, 120), completedAt: new Date() },
  });
}

export type JobHandlers = {
  createMarket?: (requestId: string) => Promise<{ status: string }>;
  resolveMarket?: (resolutionId: string) => Promise<{ status: string }>;
};

export async function registerWorker(boss: PgBoss, db: PrismaClient, handlers: JobHandlers = {}): Promise<void> {
  await boss.work<ProbeData>(PROBE_QUEUE, { pollingIntervalSeconds: 1 }, async jobs => {
    for (const job of jobs) await recordProbe(db, job.id, job.data);
  });
  await boss.work<CreationJobData>(CREATION_QUEUE, { pollingIntervalSeconds: 2 }, async jobs => {
    for (const job of jobs) {
      const { requestId } = creationJobSchema.parse(job.data);
      if (!handlers.createMarket) throw new Error('creation_handler_not_configured');
      try {
        const result = await handlers.createMarket(requestId);
        await recordRun(db, requestId, job.id, `creation:${result.status}`);
      } catch (error) {
        await recordRun(db, requestId, job.id, 'creation:FAILED');
        throw error;
      }
    }
  });
  await boss.work<ResolutionJobData>(RESOLUTION_QUEUE, { pollingIntervalSeconds: 2 }, async jobs => {
    for (const job of jobs) {
      const { resolutionId } = resolutionJobSchema.parse(job.data);
      if (!handlers.resolveMarket) throw new Error('resolution_handler_not_configured');
      try {
        const result = await handlers.resolveMarket(resolutionId);
        await recordRun(db, resolutionId, job.id, `resolution:${result.status}`);
      } catch (error) {
        await recordRun(db, resolutionId, job.id, 'resolution:FAILED');
        throw error;
      }
    }
  });
}
