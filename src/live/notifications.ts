import type { Prisma } from '@prisma/client';
import { creationTopic, type LiveMessage } from './messages.js';

export type NotificationSource = 'receipt' | 'stream';
export type CreatedNotice = {
  requestId: string; position?: number; marketAddress: string; question: string;
  source: NotificationSource; blockNumber?: number; txHash?: string | null;
};
/** The one notice a group gets: the event, once its last selected child exists. */
export type EventCreatedNotice = {
  requestId: string; slug: string; title: string; markets: number;
  source: NotificationSource; blockNumber?: number; txHash?: string | null;
};
/** `<requestId>:<position or ->:<market>`: the same market can only ever be announced once. */
export const notificationKey = (requestId: string, position: number | undefined, market: string) =>
  `${requestId}:${position ?? '-'}:${market.toLowerCase()}`;
/** `<requestId>:event`: one per group request, however many children it has. */
export const eventNotificationKey = (requestId: string) => `${requestId}:event`;

export const presentNotification = (row: {
  id: string; kind: string; title: string; body: string; href: string; marketAddress: string; position: number | null;
  sources: string[]; readAt: Date | null; createdAt: Date; blockNumber: number | null;
}) => ({
  id: row.id, kind: row.kind, title: row.title, body: row.body, href: row.href, marketAddress: row.marketAddress,
  position: row.position, sources: row.sources, readAt: row.readAt, createdAt: row.createdAt, blockNumber: row.blockNumber,
});

type Witness = { dedupeKey: string; source: NotificationSource; blockNumber?: number; txHash?: string | null };

/** Records a notice for whichever path saw it first and merges the other's source into it. */
async function upsertNotification(tx: Prisma.TransactionClient, witness: Witness,
  create: Omit<Prisma.NotificationUncheckedCreateInput, 'dedupeKey' | 'sources' | 'blockNumber' | 'txHash'>) {
  const existing = await tx.notification.findUnique({ where: { dedupeKey: witness.dedupeKey } });
  const row = existing
    ? await tx.notification.update({ where: { dedupeKey: witness.dedupeKey }, data: {
        sources: existing.sources.includes(witness.source) ? existing.sources : [...existing.sources, witness.source],
        blockNumber: existing.blockNumber ?? witness.blockNumber ?? null, txHash: existing.txHash ?? witness.txHash ?? null,
      } })
    : await tx.notification.create({ data: { ...create, dedupeKey: witness.dedupeKey,
        blockNumber: witness.blockNumber ?? null, txHash: witness.txHash ?? null, sources: [witness.source] } });
  return { notification: row, created: !existing };
}

/**
 * "Your market was created", for a standalone market. Wording is deliberate: the market exists;
 * whether it can be traded is a separate fact, decided by executable liquidity, and never
 * claimed here.
 */
export async function upsertCreatedNotification(tx: Prisma.TransactionClient, notice: CreatedNotice) {
  const market = notice.marketAddress.toLowerCase();
  return upsertNotification(tx, { ...notice, dedupeKey: notificationKey(notice.requestId, notice.position, market) }, {
    requestId: notice.requestId, position: notice.position ?? null, marketAddress: market, kind: 'market.created',
    title: 'Your market was created', body: notice.question.slice(0, 200), href: `/markets/${market}`,
  });
}

/**
 * "Your event was created", for a group. A creator who asked for an event of ten markets hears
 * once, when the tenth exists — not ten times. The notice names no single market, so its
 * address is empty; its block and transaction are the ones that completed the group.
 */
export async function upsertEventCreatedNotification(tx: Prisma.TransactionClient, notice: EventCreatedNotice) {
  const count = notice.markets === 1 ? '1 market' : `${notice.markets} markets`;
  return upsertNotification(tx, { ...notice, dedupeKey: eventNotificationKey(notice.requestId) }, {
    requestId: notice.requestId, position: null, marketAddress: '', kind: 'event.created',
    title: 'Your event was created', body: `${notice.title} · ${count}`.slice(0, 200), href: `/events/${notice.slug}`,
  });
}

/** The private message a creator's open tab receives for a request that moved. */
export const creationMessage = (requestId: string, payload: Record<string, unknown>): LiveMessage =>
  ({ type: 'creation.updated', topic: creationTopic(requestId), payload: { requestId, ...payload } });
