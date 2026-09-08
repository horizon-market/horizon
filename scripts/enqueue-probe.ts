import { randomUUID } from 'node:crypto';
import { databaseUrl } from '../src/config.js';
import { startQueue, enqueueProbe } from '../src/jobs.js';

const boss = await startQueue(databaseUrl());
try {
  const probeId = randomUUID();
  const jobId = await enqueueProbe(boss, { probeId, label: 'Manual foundation check' });
  console.log(JSON.stringify({ probeId, jobId, note: 'Start the worker; inspect JobRun in /admin after completion.' }));
} finally {
  await boss.stop();
}
