import { useState, type ReactNode } from 'react';
import { ApiError, type AuditEventView, type AuditTrail } from '../api';
import { Badge, Card, HelpLink, Notice, describe } from './Ui';
import { dateTime, short } from '../format';

// ---------------------------------------------------------------------------
// The public audit trail: what Horizon has published about a creation request on the Hedera
// Consensus Service, shown wherever the request's markets are — the event page, the market page
// and the creation flow. The data is the same everywhere; only how it was fetched differs.
// ---------------------------------------------------------------------------

export const AUDIT_LABEL: Record<string, string> = {
  DRAFT_APPROVED: 'Draft approved', PAYMENT_SETTLED: 'Payment settled', MARKET_CREATED: 'Market created',
};
export const AUDIT_STATUS: Record<string, string> = {
  PENDING: 'Pending', PUBLISHING: 'Publishing', UNCONFIRMED: 'Unconfirmed', PUBLISHED: 'Published', FAILED: 'Not published',
};
export const AUDIT_BADGE: Record<string, 'open' | 'closed' | 'resolved' | 'warn' | 'no'> = {
  PENDING: 'open', PUBLISHING: 'open', UNCONFIRMED: 'warn', PUBLISHED: 'resolved', FAILED: 'no',
};

/** The market a MARKET_CREATED statement records, read from its own payload. */
function createdMarket(event: AuditEventView): { address: string; position?: number } | undefined {
  if (event.type !== 'MARKET_CREATED') return undefined;
  const market = (event.payload as { market?: { address?: string; position?: number } } | null)?.market;
  return market?.address ? { address: market.address, position: market.position } : undefined;
}

const sameAddress = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const published = (audit: AuditTrail) => audit.events.filter(event => event.status === 'PUBLISHED').length;

/**
 * What Horizon has published about this request on the Hedera Consensus Service, and what that
 * does and does not mean. Three states are kept apart on purpose: a statement is pending until it
 * reaches consensus, unconfirmed when its submission outcome is unknown, and published only with
 * a consensus timestamp and a sequence number anyone can read back for themselves.
 */
export function AuditTrailCard({ audit: initial, verify, highlightAddress, outcomeLabel, id, children }: {
  audit: AuditTrail | undefined;
  /** Re-reads the trail with a mirror-node check. Absent when the caller has no way to ask for one. */
  verify?: () => Promise<AuditTrail>;
  /** The market this page is about, so its own deployment statement stands out from its siblings'. */
  highlightAddress?: string;
  /** The outcome a child position stands for, when the caller knows the event. */
  outcomeLabel?: (position: number) => string | undefined;
  id?: string;
  children?: ReactNode;
}) {
  const [trail, setTrail] = useState<AuditTrail | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const audit = trail ?? initial;
  if (!audit || audit.events.length === 0) return null;
  const verification = new Map((audit.verification ?? []).map(entry => [entry.eventId, entry]));

  const check = async () => {
    if (!verify) return;
    setBusy(true); setError(undefined);
    try { setTrail(await verify()); }
    catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : 'The mirror node could not be read.'); }
    finally { setBusy(false); }
  };

  return (
    <Card
      id={id}
      title="Public audit trail"
      actions={
        <span className="row">
          <HelpLink href="/audit">How the audit trail works</HelpLink>
          {verify && audit.available && published(audit) > 0 && (
            <button disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Verify on the mirror node'}</button>
          )}
        </span>
      }
    >
      <p className="small muted">
        Hedera Consensus Service records <strong>Horizon&rsquo;s own statements</strong> about this request and the order in
        which it made them &mdash; not the payment, the deployment or the outcome, each of which is checked at its own source.
      </p>
      {audit.available
        ? <p className="small muted">
            Topic <a className="mono" href={audit.topicUrl ?? '#'} target="_blank" rel="noreferrer">{audit.topicId}</a> on
            Hedera {audit.network} &middot; schema <span className="mono">{audit.schema}</span> &middot; delivery is
            at least once, so a statement whose submission outcome was unknown can appear twice. Deduplicate by event id.
          </p>
        : <Notice kind="info">No topic is configured on this deployment, so nothing has been published yet. Every statement below is recorded and can be published later.</Notice>}
      {children}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="scroll">
        <table>
          <thead><tr><th>Statement</th><th>Publication</th><th>Consensus timestamp</th><th>Record</th></tr></thead>
          <tbody>
            {audit.events.map(event => {
              const checked = verification.get(event.eventId);
              const created = createdMarket(event);
              const label = created?.position === undefined ? undefined : outcomeLabel?.(created.position);
              const mine = sameAddress(created?.address, highlightAddress);
              return (
                <tr key={event.eventId} className={mine ? 'highlight' : undefined}>
                  <td>
                    {AUDIT_LABEL[event.type] ?? event.type}
                    {mine && <> <Badge kind="open">This market</Badge></>}
                    {created && (
                      <div className="small muted">
                        {label && <>{label} &middot; </>}
                        <a className="mono" href={`/markets/${created.address.toLowerCase()}`}>{short(created.address)}</a>
                      </div>
                    )}
                    <div className="small muted mono">{short(event.eventId)}</div>
                  </td>
                  <td>
                    <Badge kind={AUDIT_BADGE[event.status] ?? 'open'}>{AUDIT_STATUS[event.status] ?? event.status}</Badge>
                    {event.status === 'UNCONFIRMED' && <div className="small muted">Submitted; the outcome is unknown and is being reconciled against the mirror node.</div>}
                    {event.failureCode && event.status !== 'PUBLISHED' && <div className="small muted">{event.failureCode}</div>}
                    {checked && <div className="small muted">{checked.matches ? 'Read back from the mirror node and matched byte for byte.' : `Not verified: ${checked.reason ?? 'unknown'}.`}</div>}
                  </td>
                  <td>
                    {event.consensusAt
                      ? <>
                          {dateTime(event.consensusAt)}
                          {event.backfilled && <div className="small muted">Recorded after the fact: this is when Horizon published the statement, not when the event happened ({dateTime(event.occurredAt)}).</div>}
                        </>
                      : <span className="muted">&mdash; <span className="small">not yet at consensus</span></span>}
                  </td>
                  <td>
                    {event.mirrorUrl
                      ? <>
                          <a className="mono" href={event.mirrorUrl} target="_blank" rel="noreferrer">#{event.sequenceNumber}</a>
                          {event.transactionUrl && <> &middot; <a className="mono" href={event.transactionUrl} target="_blank" rel="noreferrer">{short(event.transactionId ?? '')}</a></>}
                        </>
                      : <span className="muted">&mdash;</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * One line for a page header: whether anything about this request is on the topic yet. Silent
 * until there is something to say, so a market that predates the trail shows nothing rather
 * than "0 statements".
 */
export function AuditBadge({ audit, href = '#audit' }: { audit?: AuditTrail; href?: string }) {
  if (!audit || audit.events.length === 0) return null;
  const count = published(audit);
  if (count === 0) return <a className="badge open" href={href}>Audit pending</a>;
  return <a className="badge resolved" href={href}>Audited on Hedera &middot; {count} statement{count === 1 ? '' : 's'}</a>;
}

/**
 * The record of one market's own deployment, for a details list: its mirror-node and HashScan
 * links when published, its state when not, and nothing when this market has no statement.
 */
export function AuditRecordLine({ audit, address, href = '#audit' }: { audit?: AuditTrail; address: string; href?: string }) {
  const event = audit?.events.find(entry => sameAddress(createdMarket(entry)?.address, address));
  if (!event) return null;
  if (event.status !== 'PUBLISHED' || !event.mirrorUrl) {
    return <>Recorded &middot; {AUDIT_STATUS[event.status]?.toLowerCase() ?? event.status} on Hedera &middot; <a href={href}>full trail</a></>;
  }
  return (
    <>
      Published on Hedera {audit!.network} &middot;{' '}
      <a className="mono" href={event.mirrorUrl} target="_blank" rel="noreferrer">#{event.sequenceNumber}</a>
      {event.transactionUrl && <> &middot; <a className="mono" href={event.transactionUrl} target="_blank" rel="noreferrer">{short(event.transactionId ?? '')}</a></>}
      {' '}&middot; <a href={href}>full trail</a>
    </>
  );
}
