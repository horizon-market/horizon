import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEvents } from '../src/stream/events.js';
import { MessageBatch } from '../src/live/messages.js';
import { eventNotificationKey, notificationKey } from '../src/live/notifications.js';

const hex = (byte: number, length: number) => `0x${byte.toString(16).padStart(2, '0').repeat(length)}`;
const base = { contract: hex(0x2b, 20), blockNumber: '11700000', blockHash: hex(0xee, 32), blockTimestamp: '1789000000', txHash: hex(0xab, 32), txIndex: 3 };

test('module output decodes to typed events in log order, with addresses lower-cased', () => {
  const { events, dropped } = decodeEvents({ events: [
    { ...base, kind: 'ROUTE_EXECUTED', logIndex: 9, routeExecuted: { market: hex(0x11, 20).toUpperCase().replace('0X', '0x'), taker: hex(0x33, 20), recipient: hex(0x33, 20),
      isYes: true, isBuy: true, shares: '2000000', usdcAmount: '900000', fills: '2' } },
    { ...base, kind: 'CURVE_FILLED', logIndex: 4, curveFilled: { orderHash: hex(0xaa, 32), market: hex(0x11, 20), maker: hex(0xd4, 20), shares: '1000000', usdcAmount: '450000', totalFilled: '3000000' } },
    // Protobuf JSON omits a zero field; the schema fills it in rather than refusing the block.
    { ...base, kind: 'MARKET_CREATED', marketCreated: { creationId: hex(0x01, 32), market: hex(0x11, 20), resolver: hex(0xa1, 20), yesToken: hex(0xb2, 20), noToken: hex(0xc3, 20),
      closeAt: '1800000000', question: 'Will it?', rules: 'R', evidenceSource: 'E' } },
    { ...base, kind: 'DOCKED', logIndex: 5 },
  ] });
  assert.equal(dropped, 1);
  assert.deepEqual(events.map(event => [event.kind, event.logIndex]), [['MARKET_CREATED', 0], ['CURVE_FILLED', 4], ['ROUTE_EXECUTED', 9]]);
  const route = events[2]!;
  assert.equal(route.kind, 'ROUTE_EXECUTED');
  if (route.kind === 'ROUTE_EXECUTED') {
    assert.equal(route.data.market, hex(0x11, 20));
    assert.equal(route.data.fills, '2');
  }
  assert.equal(route.blockNumber, 11_700_000);
  assert.equal(route.blockTimestamp, 1_789_000_000);
});

test('an output that is not the module schema is refused', () => {
  assert.throws(() => decodeEvents({ events: [{ ...base, kind: 'SOMETHING_ELSE', logIndex: 1 }] }));
  assert.throws(() => decodeEvents({ events: [{ ...base, kind: 'CURVE_FILLED', logIndex: 1, curveFilled: { orderHash: 'nope' } }] }));
});

test('the notification key is the request, the position and the market, never anything else', () => {
  assert.equal(notificationKey('req', undefined, '0xABC'), 'req:-:0xabc');
  assert.equal(notificationKey('req', 2, '0xabc'), 'req:2:0xabc');
  assert.notEqual(notificationKey('req', 0, '0xabc'), notificationKey('req', undefined, '0xabc'));
  // A group's one notice is keyed on the request alone, and can never collide with a market's.
  assert.equal(eventNotificationKey('req'), 'req:event');
});

test('one block of fills coalesces to one message per market per type', () => {
  const batch = new MessageBatch(11_700_000, false);
  // Four fills across two makers whose other markets overlap.
  for (const market of ['0xA', '0xa', '0xb', '0xA']) { batch.liquidityChanged(market); batch.marketUpdated(market); }
  for (const other of ['0xc', '0xb', '0xc']) batch.liquidityChanged(other);
  batch.push('trade.executed', 'public', { market: '0xa' });
  const messages = batch.drain();
  assert.deepEqual(messages.map(message => `${message.type}:${message.payload.market}`).sort(), [
    'liquidity.changed:0xa', 'liquidity.changed:0xb', 'liquidity.changed:0xc', 'market.updated:0xa', 'market.updated:0xb', 'trade.executed:0xa',
  ]);
  // The private, more specific message leads; the public fan-out follows.
  assert.equal(messages[0]!.type, 'trade.executed');
  assert.equal(messages[0]!.payload.final, false);
  assert.equal(messages[0]!.payload.blockNumber, 11_700_000);
});

test('recorded Sepolia output decodes: a route with its fills is one trade, in log order', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/substreams/sepolia-phase2.json', import.meta.url), 'utf8')) as { blocks: { number: number; output: unknown }[] };
  const trade = fixture.blocks.find(block => block.number === 11_663_775)!;
  const { events, dropped } = decodeEvents(trade.output);
  assert.equal(dropped, 0);
  assert.deepEqual(events.map(event => event.kind), ['CURVE_FILLED', 'COLLATERAL_CHANGED', 'CURVE_FILLED', 'COLLATERAL_CHANGED', 'ROUTE_EXECUTED']);
  const route = events[4]!;
  assert.equal(route.kind, 'ROUTE_EXECUTED');
  if (route.kind === 'ROUTE_EXECUTED') assert.equal(route.data.fills, '2');
  assert.ok(events.every((event, index) => index === 0 || events[index - 1]!.logIndex < event.logIndex));
});
