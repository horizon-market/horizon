import type { Prisma } from '@prisma/client';
import { creationTopic, type LiveMessage } from './messages.js';

export type NotificationSource = 'receipt' | 'stream';
export type CreatedNotice = {
  requestId: string; position?: number; marketAddress: string; question: string;
  source: NotificationSource; blockNumber?: number; txHash?: string | null;
};
/** `<requestId>:<position or ->:<market>`: the same market can only ever be announced once. */
export const notificationKey = (requestId: string, position: number | undefined, market: string) =>
  `${requestId}:${position ?? '-'}:${market.toLowerCase()}`;

export const presentNotification = (row: {
  id: string; kind: string; title: string; body: string; href: string; marketAddress: string; position: number | null;
  sources: string[]; readAt: Date | null; createdAt: Date; blockNumber: number | null;
}) => ({
  id: row.id, kind: row.kind, title: row.title, body: row.body, href: row.href, marketAddress: row.marketAddress,
  position: row.position, sources: row.sources, readAt: row.readAt, createdAt: row.createdAt, blockNumber: row.blockNumber,
});

/**
 * Records "your market was created" for whichever path saw it first and merges the other into it.
 * Wording is deliberate: the market exists; whether it can be traded is a separate fact, decided by
 * executable liquidity, and never claimed here.
 */
export async function upsertCreatedNotification(tx: Prisma.TransactionClient, notice: CreatedNotice) {
  const dedupeKey = notificationKey(notice.requestId, notice.position, notice.marketAddress);
  const existing = await tx.notification.findUnique({ where: { dedupeKey } });
  const market = notice.marketAddress.toLowerCase();
  const row = existing
    ? await tx.notification.update({ where: { dedupeKey }, data: {
        sources: existing.sources.includes(notice.source) ? existing.sources : [...existing.sources, notice.source],
        blockNumber: existing.blockNumber ?? notice.blockNumber ?? null, txHash: existing.txHash ?? notice.txHash ?? null,
      } })
    : await tx.notification.create({ data: {
        dedupeKey, requestId: notice.requestId, position: notice.position ?? null, marketAddress: market, kind: 'market.created',
        title: 'Your market was created', body: notice.question.slice(0, 200), href: `/markets/${market}`,
        blockNumber: notice.blockNumber ?? null, txHash: notice.txHash ?? null, sources: [notice.source],
      } });
  return { notification: row, created: !existing };
}

/** The private message a creator's open tab receives for a request that moved. */
export const creationMessage = (requestId: string, payload: Record<string, unknown>): LiveMessage =>
  ({ type: 'creation.updated', topic: creationTopic(requestId), payload: { requestId, ...payload } });
