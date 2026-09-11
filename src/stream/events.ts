import { z } from 'zod';

/**
 * The `horizon.v1.HorizonEvents` message as protobuf JSON: camelCase fields, 64-bit integers as
 * strings, the oneof flattened to whichever member is set. Validated on the way in so a package
 * that drifted from this schema is refused at the boundary rather than written to the database.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase());
const hexBytes = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform(value => value.toLowerCase());
const decimal = z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]).transform(String);
const integer = z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]).transform(Number).default(0);

export const KINDS = ['MARKET_CREATED', 'CURVE_FILLED', 'ROUTE_EXECUTED', 'STRATEGY_ADMITTED', 'SHIPPED', 'DOCKED', 'COLLATERAL_CHANGED', 'MARKET_RESOLVED'] as const;
export type EventKind = typeof KINDS[number];

const marketCreated = z.object({ creationId: hash32, market: address, resolver: address, yesToken: address, noToken: address,
  closeAt: integer, question: z.string().max(400).default(''), rules: z.string().max(4000).default(''), evidenceSource: z.string().max(1000).default('') });
const curveFilled = z.object({ orderHash: hash32, market: address, maker: address, shares: decimal, usdcAmount: decimal, totalFilled: decimal });
const routeExecuted = z.object({ market: address, taker: address, recipient: address, isYes: z.boolean().default(false), isBuy: z.boolean().default(false),
  shares: decimal, usdcAmount: decimal, fills: decimal });
const strategyAdmitted = z.object({ orderHash: hash32, market: address, maker: address, token: address, commitment: decimal, committedBefore: decimal, spendable: decimal });
const shipped = z.object({ maker: address, app: address, strategyHash: hash32, strategy: hexBytes });
const docked = z.object({ maker: address, app: address, strategyHash: hash32 });
const collateralChanged = z.object({ market: address, collateral: decimal });
const marketResolved = z.object({ market: address, result: integer, resolver: address, evidence: z.string().max(2000).default('') });

const envelope = z.object({
  kind: z.enum(KINDS), contract: address, blockNumber: integer, blockHash: hash32, blockTimestamp: integer,
  txHash: hash32, logIndex: integer, txIndex: integer,
  marketCreated: marketCreated.optional(), curveFilled: curveFilled.optional(), routeExecuted: routeExecuted.optional(),
  strategyAdmitted: strategyAdmitted.optional(), shipped: shipped.optional(), docked: docked.optional(),
  collateralChanged: collateralChanged.optional(), marketResolved: marketResolved.optional(),
});
export const horizonEventsSchema = z.object({ events: z.array(envelope).default([]) });

type Envelope = z.infer<typeof envelope>;
type Base = Pick<Envelope, 'contract' | 'blockNumber' | 'blockHash' | 'blockTimestamp' | 'txHash' | 'logIndex' | 'txIndex'>;
export type ChainEvent = Base & (
  | { kind: 'MARKET_CREATED'; data: z.infer<typeof marketCreated> }
  | { kind: 'CURVE_FILLED'; data: z.infer<typeof curveFilled> }
  | { kind: 'ROUTE_EXECUTED'; data: z.infer<typeof routeExecuted> }
  | { kind: 'STRATEGY_ADMITTED'; data: z.infer<typeof strategyAdmitted> }
  | { kind: 'SHIPPED'; data: z.infer<typeof shipped> }
  | { kind: 'DOCKED'; data: z.infer<typeof docked> }
  | { kind: 'COLLATERAL_CHANGED'; data: z.infer<typeof collateralChanged> }
  | { kind: 'MARKET_RESOLVED'; data: z.infer<typeof marketResolved> }
);

const MEMBER: Record<EventKind, keyof Envelope> = {
  MARKET_CREATED: 'marketCreated', CURVE_FILLED: 'curveFilled', ROUTE_EXECUTED: 'routeExecuted', STRATEGY_ADMITTED: 'strategyAdmitted',
  SHIPPED: 'shipped', DOCKED: 'docked', COLLATERAL_CHANGED: 'collateralChanged', MARKET_RESOLVED: 'marketResolved',
};

/** Module output → typed events in log order. An event whose oneof member is missing is dropped, and said so. */
export function decodeEvents(output: unknown): { events: ChainEvent[]; dropped: number } {
  const parsed = horizonEventsSchema.parse(output);
  const events: ChainEvent[] = [];
  let dropped = 0;
  for (const item of parsed.events) {
    const data = item[MEMBER[item.kind]];
    if (!data || typeof data !== 'object') { dropped++; continue; }
    const { contract, blockNumber, blockHash, blockTimestamp, txHash, logIndex, txIndex } = item;
    events.push({ kind: item.kind, data, contract, blockNumber, blockHash, blockTimestamp, txHash, logIndex, txIndex } as ChainEvent);
  }
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { events, dropped };
}
