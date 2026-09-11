import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { LiveBus } from './bus.js';
import { PUBLIC_TOPIC, creationTopic, type LiveEventRecord } from './messages.js';
import type { CreationService } from '../creation/service.js';

const subscriptionSchema = z.object({
  // Creation request tokens travel in the body, never in the URL, and are checked against their
  // hashes exactly as every other creation call checks them.
  creations: z.array(z.object({ id: z.string().uuid(), token: z.string().min(16).max(256) })).max(50).default([]),
}).strict();
const KEEPALIVE_MS = 20_000;
const MAX_CONNECTIONS = 500;

const frame = (event: LiveEventRecord) => `id: ${event.id.toString()}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;

/**
 * `POST /api/live`: one server-sent event stream per browser tab, opened once at the app root and
 * kept across page changes. Public topics need no credential; private ones — a creator's own
 * request — need the same bearer token that reads the request. A tab that reconnects sends the
 * last id it saw and is either caught up from the replay log or told to refetch.
 */
export function liveRoutes(bus: LiveBus | undefined, creation?: CreationService) {
  const router = Router();
  const limit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  router.post('/live', limit, async (req, res: Response) => {
    if (!bus) { res.status(503).json({ error: 'live_not_configured' }); return; }
    const input = subscriptionSchema.safeParse(req.body ?? {});
    if (!input.success) { res.status(400).json({ error: 'invalid_subscription' }); return; }
    if (bus.connections >= MAX_CONNECTIONS) { res.status(503).json({ error: 'live_capacity' }); return; }
    const topics = new Set<string>([PUBLIC_TOPIC]);
    if (creation && input.data.creations.length) {
      for (const id of await creation.authorized(input.data.creations)) topics.add(creationTopic(id));
    }
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const write = (chunk: string) => { if (!res.writableEnded) res.write(chunk); };
    // Which topics this tab may hear is stated up front, so the client knows which private
    // subscriptions were refused without being told why.
    write(`event: subscribed\ndata: ${JSON.stringify({ topics: [...topics].filter(topic => topic !== PUBLIC_TOPIC).map(topic => topic.slice('creation:'.length)) })}\n\n`);
    const since = req.get('last-event-id');
    let delivered = 0n;
    if (since && /^\d{1,18}$/.test(since)) {
      const replay = await bus.replay(BigInt(since), topics);
      if (!replay.complete) write(`event: snapshot.required\ndata: ${JSON.stringify({ since })}\n\n`);
      for (const event of replay.events) { write(frame(event)); delivered = event.id; }
    }
    const unsubscribe = bus.subscribe({ topics, send: event => {
      // A message that was replayed above is not sent again.
      if (event.id <= delivered) return;
      delivered = event.id;
      write(frame(event));
    } });
    const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
    // The request's own `close` fires once its body is consumed; only the response's `close`
    // says the browser went away, which is when this subscription ends.
    res.on('close', () => { clearInterval(keepalive); unsubscribe(); });
  });
  return router;
}
