import { useEffect, useRef, useState } from 'react';
import { api, type CreationNotification } from '../api';
import { allCreations, creationToken, onCreationsChanged } from '../creations';
import { navigate, useLive } from '../hooks';
import { live } from '../live';
import { TxLink } from './Ui';
import { Toasts, type ToastItem } from './Toasts';

type Notice = CreationNotification & { requestId: string };
const RECENT = 5;

/**
 * The creator's notices, stacked at the corner of the site: "market created" with the question,
 * or "event created" once a group's last market exists, and the way there.
 *
 * Notices arrive live while the tab is open and are read back from the server when it is not,
 * so a creator who left mid-creation still finds theirs on return. Only unread ones are shown.
 * Opening one, or dismissing it, marks it read with the same token that reads the request — the
 * server keeps it either way, and the portfolio still lists the market.
 */
export function LiveNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  // Ids that arrived over the stream in this tab: those pulse; the ones found on load do not.
  const fresh = useRef(new Set<string>());
  const merge = (incoming: Notice[]) => setNotices(current => {
    const byId = new Map(current.map(notice => [notice.id, notice]));
    for (const notice of incoming) if (!notice.readAt) byId.set(notice.id, notice); else byId.delete(notice.id);
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  // Follow the archive: every request this browser holds a token for is subscribed to, and the
  // most recent few are read back for notices that arrived while no tab was open.
  useEffect(() => {
    live.start();
    const follow = () => {
      const claims = allCreations();
      live.setClaims(claims.slice(0, 50));
      for (const claim of claims.slice(0, RECENT)) {
        api.getRequest(claim.id, claim.token).then(
          result => merge((result.request.notifications ?? []).map(notice => ({ ...notice, requestId: claim.id }))),
          () => undefined,
        );
      }
    };
    follow();
    return onCreationsChanged(follow);
  }, []);

  useLive(event => {
    if (event.type !== 'creation.updated') return;
    const requestId = String(event.payload.requestId ?? '');
    const notification = event.payload.notification as CreationNotification | undefined;
    if (notification && requestId) {
      if (!notices.some(notice => notice.id === notification.id)) fresh.current.add(notification.id);
      merge([{ ...notification, requestId }]);
    }
    // A reorg withdrew the block that announced this market; the notice goes with it.
    if (event.payload.reverted && typeof event.payload.notificationId === 'string') {
      setNotices(current => current.filter(notice => notice.id !== event.payload.notificationId));
    }
  });

  const markRead = (notice: Notice) => {
    const token = creationToken(notice.requestId);
    if (token) void api.markNotificationRead(notice.requestId, token, notice.id).catch(() => undefined);
  };
  const dismiss = (notice: Notice) => {
    setNotices(current => current.filter(item => item.id !== notice.id));
    markRead(notice);
  };
  const dismissAll = () => { for (const notice of notices) markRead(notice); setNotices([]); };
  const byId = new Map(notices.map(notice => [notice.id, notice]));

  return (
    <Toasts items={notices.map(present).map(item => ({ ...item, fresh: fresh.current.has(item.id) }))}
      onDismiss={item => { const notice = byId.get(item.id); if (notice) dismiss(notice); }}
      onDismissAll={dismissAll}
      onOpen={item => { const notice = byId.get(item.id); if (notice) dismiss(notice); navigate(item.action.href); }} />
  );
}

/**
 * The card's words. The headline is the thing itself — the question, or the event's title — and
 * the status is what happened to it; "created" and nothing more, since whether it can be traded
 * is decided by liquidity, not by this notice. A notice only the chain stream has vouched for is
 * still `confirming`: the worker's receipt has not arrived, and a reorg could yet withdraw it.
 */
export function present(notice: Notice): ToastItem {
  const event = notice.kind === 'event.created';
  const confirmed = notice.sources.includes('receipt');
  // An event notice's body is `<title> · <n markets>`, as written by the API.
  const split = event ? notice.body.lastIndexOf(' · ') : -1;
  const headline = split > 0 ? notice.body.slice(0, split) : notice.body || notice.title;
  const count = split > 0 ? notice.body.slice(split + 3) : undefined;
  return {
    id: notice.id, headline,
    status: event ? `Event created${count ? ` · ${count}` : ''}` : 'Market created',
    tone: confirmed ? 'ok' : 'pending', note: confirmed ? undefined : 'confirming',
    meta: (notice.blockNumber || notice.txHash) && (
      <>
        {notice.blockNumber && <>Block <span className="mono">{notice.blockNumber.toLocaleString()}</span></>}
        {notice.blockNumber && notice.txHash && ' · '}
        {notice.txHash && <TxLink hash={notice.txHash} />}
      </>
    ),
    action: { label: event ? 'Open event' : 'Open market', href: notice.href },
  };
}
