import { readFile } from 'node:fs/promises';
import { createConnectTransport } from '@connectrpc/connect-node';
import type { Interceptor } from '@connectrpc/connect';
import { createRegistry, createRequest, createSubstream, fetchSubstream, streamBlocks, unpackMapOutput, authIssue } from '@substreams/core';
import type { Package } from '@substreams/core/proto';
import type { StreamConfig } from '../config.js';
import { decodeEvents, type ChainEvent } from './events.js';

export type StreamHandlers = {
  onBlock(block: { number: number; hash: string; timestamp: number; cursor: string; finalBlock: number; events: ChainEvent[]; dropped: number }): Promise<void>;
  onUndo(lastValid: { number: number; hash: string; cursor: string }): Promise<void>;
};

/** Never the endpoint, never a token: only the shape of what went wrong. */
export function describeStreamError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return { name: error instanceof Error ? error.name : 'Error', code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    message: message.replace(/https?:\/\/\S+/gi, '[url]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/server_[A-Za-z0-9]+/g, '[redacted]').slice(0, 300) };
}

async function loadPackage(source: string): Promise<Package> {
  if (/^https?:\/\//.test(source)) return fetchSubstream(source);
  return createSubstream(await readFile(source));
}

/**
 * The stream's credential. A JWT is sent as a bearer token; an API key is exchanged for one at
 * the StreamingFast auth service, which is how the `substreams` CLI itself authenticates.
 */
async function authorization(config: StreamConfig): Promise<Interceptor> {
  let token = config.token;
  if (!token && config.apiKey) token = (await authIssue(config.apiKey)).token;
  if (!token) throw new Error('stream_not_authenticated');
  return next => request => { request.header.set('authorization', `Bearer ${token}`); return next(request); };
}

/**
 * Opens one stream and drives it to completion or failure. Blocks are handled strictly in order
 * and the next one is not read until the handler returns, so a slow database pushes back on the
 * server rather than piling blocks up in memory. Returns when the server closes the stream; throws
 * on any error, and the caller decides whether to reconnect.
 */
export async function runStream(config: StreamConfig, startCursor: string | undefined, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  const substreamPackage = await loadPackage(config.package);
  const registry = createRegistry(substreamPackage);
  // The package's own type declarations resolve `@connectrpc/connect` through its CommonJS entry
  // while this module sees the ESM one; the runtime object is the same either way.
  const transport = createConnectTransport({ baseUrl: config.endpoint, httpVersion: '2', interceptors: [await authorization(config)] }) as unknown as Parameters<typeof streamBlocks>[0];
  const request = createRequest({
    substreamPackage, outputModule: config.module, productionMode: true, finalBlocksOnly: false,
    // Live blocks with undo signals, not final-only: one confirmation is not treated as finality.
    startCursor: startCursor || undefined, startBlockNum: startCursor ? undefined : config.startBlock,
  });
  for await (const response of streamBlocks(transport, request, { signal })) {
    if (response.message.case === 'blockScopedData') {
      const block = response.message.value;
      const clock = block.clock;
      if (!clock) continue;
      let events: ChainEvent[] = [], dropped = 0;
      const empty = !block.output?.mapOutput || block.output.mapOutput.value.byteLength === 0;
      if (!empty) {
        const output = unpackMapOutput(response, registry);
        if (output) ({ events, dropped } = decodeEvents(output.toJson({ typeRegistry: registry, emitDefaultValues: true })));
      }
      await handlers.onBlock({ number: Number(clock.number), hash: clock.id.startsWith('0x') ? clock.id.toLowerCase() : `0x${clock.id.toLowerCase()}`,
        timestamp: Number(clock.timestamp?.seconds ?? 0n), cursor: block.cursor, finalBlock: Number(block.finalBlockHeight), events, dropped });
    } else if (response.message.case === 'blockUndoSignal') {
      const undo = response.message.value;
      const ref = undo.lastValidBlock;
      if (!ref) continue;
      await handlers.onUndo({ number: Number(ref.number), hash: ref.id.startsWith('0x') ? ref.id.toLowerCase() : `0x${ref.id.toLowerCase()}`, cursor: undo.lastValidCursor });
    } else if (response.message.case === 'fatalError') {
      throw new Error(`substreams_fatal: ${response.message.value.reason.slice(0, 200)}`);
    }
  }
}
