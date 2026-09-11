import { useState } from 'react';
import { api, ApiError, type EventChild, type HorizonEvent } from '../api';
import { navigate, useAsync } from '../hooks';
import { useWallet } from '../App';
import { Address, Badge, Card, Empty, ErrorBox, Loading, Notice, ZeroFee } from '../components/Ui';
import { AuditBadge, AuditTrailCard } from '../components/AuditTrail';
import { MarketOrder } from '../components/MarketOrder';
import { dateTime, price, shares, timeLeft, usdc } from '../format';

const RESULTS = ['Unresolved', 'YES', 'NO', 'INVALID'];

/** Imported artwork is decoration; a broken or blocked one must leave no gap behind. */
const hideBrokenArt = (event: { currentTarget: HTMLImageElement }) => { event.currentTarget.hidden = true; };

/**
 * One event and its children. The shared context is here — the question the group is about, the
 * rules it was created under and where its definitions came from — and each child keeps its own
 * YES/NO trading and its own market page. Nothing is aggregated across children: they are separate
 * markets with separate collateral, so a number that spanned them would be a claim about a
 * relationship that does not exist.
 */
export function EventDetail({ slug }: { slug: string }) {
  const detail = useAsync(() => api.event(slug), [slug]);
  // Read on its own: the trail is a claim about how the event was made, not part of the event,
  // so a mirror or outbox that cannot be read leaves the event page exactly as it was.
  const audit = useAsync(() => api.eventAudit(slug), [slug]);
  const account = useWallet().account;
  if (detail.loading) return <Loading rows={7} label="Loading event" />;
  if (detail.error) return <ErrorBox error={detail.error} retry={detail.reload} />;
  const { event, resolution, marketsError } = detail.data!;
  const live = event.children.filter(child => child.market);
  return (
    <div className="stack">
      <div className="row between">
        <a href="/">← All markets</a>
        <button onClick={detail.reload}>Refresh</button>
      </div>
      <ZeroFee />
      <Card>
        <div className="row between">
          <div className="row">
            <Badge kind={event.stats.open > 0 ? 'open' : event.stats.resolved === event.stats.live && event.stats.live > 0 ? 'resolved' : 'closed'}>
              {event.stats.live} market{event.stats.live === 1 ? '' : 's'}
            </Badge>
            {event.category && <span className="badge closed">{event.category}</span>}
          </div>
          <div className="row">
            <AuditBadge audit={audit.data?.audit} />
            <SourceBadge event={event} />
          </div>
        </div>
        <div className="event-head">
          {/* The source's own artwork, imported with the definition. It is loaded without a
              referrer and simply disappears if the host is unreachable or blocked. */}
          {event.imageUrl && (
            <img className="event-art" src={event.imageUrl} alt="" aria-hidden loading="lazy" referrerPolicy="no-referrer"
              onError={hideBrokenArt} />
          )}
          <div>
            <h1 style={{ marginTop: 0 }}>{event.title}</h1>
            {event.description && <p className="muted" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>{event.description}</p>}
          </div>
        </div>
        <Exclusivity event={event} note={resolution.note} />
        {event.tags.length > 0 && (
          <div className="row" style={{ marginTop: 'var(--space-3)' }}>
            {event.tags.map(tag => <span key={tag} className="badge closed">{tag}</span>)}
          </div>
        )}
      </Card>

      {marketsError && (
        <Notice kind="warn">
          Live market data could not be read, so prices and depth are missing below. The event, its outcomes and their
          market addresses are unaffected.
        </Notice>
      )}

      {event.children.length === 0
        ? <Empty title="This event has no markets yet" />
        : <div className="stack">
            {event.children.map(child => (
              <ChildRow key={child.position} child={child} account={account} onDone={detail.reload} />
            ))}
          </div>}

      {audit.data && (
        <AuditTrailCard id="audit" audit={audit.data.audit}
          verify={() => api.eventAudit(slug, true).then(result => result.audit)}
          outcomeLabel={position => event.children.find(child => child.position === position)?.outcomeLabel}>
          {audit.data.requests.length > 1 && (
            <p className="small muted">
              This event was built by {audit.data.requests.length} creation requests; their statements are shown in the order they were made.
            </p>
          )}
        </AuditTrailCard>
      )}
      {audit.error !== undefined && !(audit.error instanceof ApiError && audit.error.status === 404) && (
        <p className="small muted">The public audit trail could not be loaded.</p>
      )}

      {live.length > 0 && (
        <Card title="Local statistics">
          {/* Horizon's own numbers, and only across markets that exist here. Nothing from a source. */}
          <div className="stats">
            <div className="stat"><div className="label">Markets trading</div><div className="value">{event.stats.open}</div>
              <div className="small muted">of {event.stats.live} deployed</div></div>
            <div className="stat"><div className="label">Resolved</div><div className="value">{event.stats.resolved}</div>
              <div className="small muted">settled by the disclosed resolver</div></div>
            <div className="stat"><div className="label">Live curves</div><div className="value">{event.stats.curves}</div>
              <div className="small muted">resting orders across this group</div></div>
            <div className="stat"><div className="label">Collateral held</div><div className="value">{usdc(event.stats.collateral)}</div>
              <div className="small muted">summed from each market's own escrow</div></div>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Every figure here is Horizon's own, from its indexed and on-chain state. Collateral is a sum of separate
            escrows, not a shared pool: each market backs only its own outcome tokens.
          </p>
        </Card>
      )}
    </div>
  );
}

/** Where an imported event's definitions came from, stated as attribution and nothing more. */
function SourceBadge({ event }: { event: HorizonEvent }) {
  if (event.source.provider === 'horizon' || !event.source.url) return <span className="small muted">Created on Horizon</span>;
  return (
    <span className="small muted">
      Definitions imported from{' '}
      <a href={event.source.url} target="_blank" rel="noreferrer noopener">{event.source.provider}</a>
      {event.source.importedAt && <> on {dateTime(event.source.importedAt)}</>}
    </span>
  );
}

/**
 * Whether being in this group says anything about the outcomes. This is the distinction the whole
 * design turns on, so it is stated on the page rather than left to be inferred from a layout.
 */
function Exclusivity({ event, note }: { event: HorizonEvent; note: string }) {
  const exclusive = event.exclusivity === 'EXCLUSIVE';
  return (
    <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
      <Notice kind={exclusive ? 'info' : 'brand'}>
        <strong>{exclusive ? 'Exactly one of these outcomes is meant to win.' : 'These markets are grouped for context only.'}</strong>{' '}
        {event.exclusivityNote}
      </Notice>
      {!event.outcomesComplete && (
        <Notice kind="warn">
          This group does not cover every outcome. Treat it as a selection of markets, not as the full set of
          possibilities — the prices below need not add up to 100%.
        </Notice>
      )}
      {exclusive && (
        <p className="small muted" style={{ margin: 0 }}>
          {note} Each market holds its own collateral; there is no shared collateral and no conversion between
          sibling outcomes.
        </p>
      )}
    </div>
  );
}

/**
 * One child: its outcome, Horizon's own prices for it, and a way to trade it without leaving the
 * page. The full ticket — limit orders, curves, the book — stays on the market's own page, which
 * keeps working exactly as it did and is one click away.
 */
function ChildRow({ child, account, onDone }: { child: EventChild; account?: string; onDone: () => void }) {
  const [open, setOpen] = useState<'yes' | 'no' | undefined>();
  const market = child.market;
  if (!market || !child.marketAddress) {
    return (
      <Card>
        <div className="row between">
          <div>
            <strong>{child.outcomeLabel}</strong>
            <div className="small muted">{child.question}</div>
          </div>
          <Badge kind="warn">Not deployed</Badge>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          This outcome is part of the event but has no market on Horizon yet, so there is nothing to trade.
        </p>
      </Card>
    );
  }
  const tradable = market.status === 'OPEN';
  const address = child.marketAddress;
  return (
    <Card>
      <div className="event-row">
        <div className="event-row-name">
          <a href={`/markets/${address}`}><strong>{child.outcomeLabel}</strong></a>
          <div className="small muted">{market.question}</div>
        </div>
        <div className="event-row-meta">
          <Badge kind={market.status === 'OPEN' ? 'open' : market.status === 'RESOLVED' ? 'resolved' : 'closed'}>
            {market.status === 'RESOLVED' ? `Resolved ${RESULTS[market.result]}` : market.status}
          </Badge>
          <span className="small muted">{market.status === 'OPEN' ? timeLeft(market.closeAt) : dateTime(market.closeAt)}</span>
        </div>
        <div className="event-row-prices">
          <button className={`price-tile yes ${open === 'yes' ? 'active' : ''}`} disabled={!tradable}
            aria-expanded={open === 'yes'} onClick={() => setOpen(open === 'yes' ? undefined : 'yes')}>
            <span className="label">Buy YES</span>
            <span className="value">{price(market.liquidity.yes.ask)}</span>
            <span className="small muted">{shares(market.liquidity.yes.availableShares)} offered</span>
          </button>
          <button className={`price-tile no ${open === 'no' ? 'active' : ''}`} disabled={!tradable}
            aria-expanded={open === 'no'} onClick={() => setOpen(open === 'no' ? undefined : 'no')}>
            <span className="label">Buy NO</span>
            <span className="value">{price(market.liquidity.no.ask)}</span>
            <span className="small muted">{shares(market.liquidity.no.availableShares)} offered</span>
          </button>
        </div>
      </div>
      {open && tradable && (
        <div className="event-row-ticket">
          {/* The same market-order control the market page uses, pointed at this child. */}
          <MarketOrder market={address} side={{ isYes: open === 'yes', isBuy: true }} account={account}
            onDone={onDone} onSwitchToLimit={() => navigate(`/markets/${address}?ticket=limit&side=${open}`)} />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Selling, limit orders and curves for this outcome live on its own <a href={`/markets/${address}`}>market page</a>.
          </p>
        </div>
      )}
      {!tradable && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Trading has closed. <a href={`/markets/${address}`}>Open the market</a> to see its book and resolution.
        </p>
      )}
      <div className="row between small muted" style={{ marginTop: 'var(--space-2)' }}>
        <span><Address value={address} /> · {market.liquidity.curves} live curve{market.liquidity.curves === 1 ? '' : 's'}</span>
        <span>{usdc(market.collateral)} collateral</span>
      </div>
    </Card>
  );
}
