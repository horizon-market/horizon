import { useEffect, useState } from 'react';
import { api, type CreationNotification } from '../api';
import { allCreations, creationToken, onCreationsChanged } from '../creations';
import { live } from '../live';
import { useLive, useLiveStatus } from '../hooks';

type Notice = CreationNotification & { requestId: string };
const RECENT = 5;

/**
 * The bar at the bottom of the site: "your market was created" — or, for a group, "your event
 * was created", once, when its last market exists — with the link to it.
 *
 * Notices arrive live while the tab is open and are read back from the server when it is not,
 * so a creator who left mid-creation still finds theirs on return. Only unread ones are shown,
 * and dismissing one marks it read with the same token that reads the request — the server
 * keeps it either way.
 */
export function LiveNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const connected = useLiveStatus();
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
    if (notification && requestId) merge([{ ...notification, requestId }]);
    // A reorg withdrew the block that announced this market; the notice goes with it.
    if (event.payload.reverted && typeof event.payload.notificationId === 'string') {
      setNotices(current => current.filter(notice => notice.id !== event.payload.notificationId));
    }
  });

  const dismiss = (notice: Notice) => {
    setNotices(current => current.filter(item => item.id !== notice.id));
    const token = creationToken(notice.requestId);
    if (token) void api.markNotificationRead(notice.requestId, token, notice.id).catch(() => undefined);
  };

  if (notices.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.slice(0, 3).map(notice => (
        <div key={notice.id} className="notice-bar">
          <span className="notice-dot" aria-hidden="true" />
          <div className="notice-text">
            <strong>{notice.title}</strong>
            {notice.body && <span className="small muted"> · {notice.body}</span>}
          </div>
          <a className="button primary" href={notice.href}>{notice.kind === 'event.created' ? 'Open event' : 'Open market'}</a>
          <button aria-label="Dismiss" onClick={() => dismiss(notice)}>×</button>
          {!connected && <span className="small muted" title="Reconnecting to live updates">offline</span>}
        </div>
      ))}
    </div>
  );
}
