import { useState } from 'react';
import { api, type HorizonEvent, type Market } from '../api';
import { useAsync, useDebouncedReload, useLive, useLiveStatus } from '../hooks';
import { Badge, Empty, ErrorBox, Loading, ZeroFee } from '../components/Ui';
import { dateTime, price, shares, timeLeft, usdc } from '../format';

const STATUS: Record<Market['status'], 'open' | 'closed' | 'resolved'> = { OPEN: 'open', CLOSED: 'closed', RESOLVED: 'resolved' };
const RESULTS = ['Unresolved', 'YES', 'NO', 'INVALID'];

type Filter = 'all' | 'open' | 'closed';
/** One browsable thing: a standalone market, or an event standing for its children. */
type Entry = { key: string; createdAt: number; open: boolean } & (
  | { kind: 'market'; market: Market }
  | { kind: 'event'; event: HorizonEvent }
);

export function Markets() {
  const listing = useAsync(() => api.markets(), []);
  const [filter, setFilter] = useState<Filter>('all');
  const connected = useLiveStatus();
  // A created market, a fill or a resolution anywhere changes this list; a block's worth of them
  // is one refetch, and a reorg's withdrawal arrives the same way.
  const refetch = useDebouncedReload(listing.reload);
  useLive(event => {
    if (['market.updated', 'liquidity.changed', 'snapshot.required'].includes(event.type)) refetch();
  });
  if (listing.loading) return <Loading rows={6} label="Loading markets" />;
  if (listing.error) return <ErrorBox error={listing.error} retry={listing.reload} />;
  const data = listing.data!;
  const events = data.events ?? [];
  // A child is drawn inside its event's card and nowhere else, so nothing appears twice.
  const grouped = new Set(events.flatMap(event => event.children.map(child => child.marketAddress?.toLowerCase()).filter(Boolean) as string[]));
  const entries: Entry[] = [
    ...data.markets.filter(market => !grouped.has(market.id.toLowerCase())).map(market => ({
      kind: 'market' as const, key: market.id, market, createdAt: market.createdAt, open: market.status === 'OPEN',
    })),
    ...events.map(event => ({
      kind: 'event' as const, key: event.id, event,
      createdAt: Math.max(0, ...event.children.map(child => child.market?.createdAt ?? 0)),
      open: event.stats.open > 0,
    })),
  ].sort((left, right) => right.createdAt - left.createdAt);
  const visible = entries.filter(entry => filter === 'all' || (filter === 'open' ? entry.open : !entry.open));

  return (
    <div className="stack">
      <ZeroFee />
      <div className="row between">
        <h1>Markets</h1>
        <div className="row">
          {(['all', 'open', 'closed'] as const).map(option => (
            <button key={option} className={filter === option ? 'primary' : ''} onClick={() => setFilter(option)}>
              {option === 'all' ? 'All' : option === 'open' ? 'Open' : 'Closed & resolved'}
            </button>
          ))}
          <button onClick={listing.reload}>Refresh</button>
        </div>
      </div>
      <p className="small muted">
        <span className={`live-dot${connected ? ' on' : ''}`} aria-hidden="true" />
        Discovery reads The Graph at indexed block {data.indexedBlock}
        {data.liveBlock ? `, with live changes through block ${data.liveBlock}` : ''}. Prices and depth below are indexed estimates;
        every order is re-checked and simulated against live chain state before you sign.
        {events.length > 0 && ' Grouped events show their outcomes together; each one is a separate market you can open on its own.'}
      </p>
      {visible.length === 0
        ? <Empty title={entries.length === 0 ? 'No markets are indexed yet' : 'Nothing matches this filter'}>
            <p>Create the first one from the <a href="/create">Create market</a> page.</p>
          </Empty>
        : <div className="grid market-grid">
            {visible.map(entry => entry.kind === 'event'
              ? <EventCard key={entry.key} event={entry.event} />
              : <MarketCard key={entry.key} market={entry.market} />)}
          </div>}
    </div>
  );
}

const depth = (available: string) => `${shares(available)} share${available === '1000000' ? '' : 's'} available`;

function MarketCard({ market }: { market: Market }) {
  const yes = market.liquidity.yes, no = market.liquidity.no;
  return (
    <a className="card" href={`/markets/${market.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row between">
        <Badge kind={STATUS[market.status]}>{market.status === 'RESOLVED' ? `Resolved ${RESULTS[market.result]}` : market.status}</Badge>
        <span className="small muted">{market.status === 'OPEN' ? timeLeft(market.closeAt) : dateTime(market.closeAt)}</span>
      </div>
      <h3 style={{ marginTop: '.6rem' }}>{market.question}</h3>
      <div className="prices">
        <div className="price-tile yes">
          <div className="label">Buy YES</div>
          <div className="value">{price(yes.ask)}</div>
          <div className="small muted">{depth(yes.availableShares)}</div>
        </div>
        <div className="price-tile no">
          <div className="label">Buy NO</div>
          <div className="value">{price(no.ask)}</div>
          <div className="small muted">{depth(no.availableShares)}</div>
        </div>
      </div>
      <div className="card-foot row between small muted">
        <span>{market.liquidity.curves} live curve{market.liquidity.curves === 1 ? '' : 's'}</span>
        <span>{usdc(market.collateral)} collateral</span>
      </div>
    </a>
  );
}

/**
 * One card for an event, with a row per outcome. The rows carry Horizon's own YES price for that
 * outcome and nothing else: these are independent markets, so their prices are not a distribution
 * and are never presented as one.
 */
function EventCard({ event }: { event: HorizonEvent }) {
  const shown = event.children.slice(0, 3);
  const hidden = event.children.length - shown.length;
  const markets = event.children.flatMap(child => child.market ? [child.market] : []);
  const openMarkets = markets.filter(market => market.status === 'OPEN');
  // Use the deployed Horizon deadlines, which can differ from the source event's end date.
  const closeAt = openMarkets.length > 0
    ? Math.min(...openMarkets.map(market => market.closeAt))
    : markets.length > 0 ? Math.max(...markets.map(market => market.closeAt)) : null;
  const staggered = new Set(openMarkets.map(market => market.closeAt)).size > 1;
  return (
    <a className="card event-card" href={`/events/${event.slug}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <div className="row between">
        <div className="row">
          <Badge kind={event.stats.open > 0 ? 'open' : 'closed'}>
            {event.stats.live} market{event.stats.live === 1 ? '' : 's'}
          </Badge>
          {event.exclusivity === 'EXCLUSIVE' && <span className="badge warn" title={event.exclusivityNote}>One winner</span>}
        </div>
        <div className="small muted" style={{ textAlign: 'right' }}>
          {closeAt !== null && <div title={`${staggered ? 'Next market closes' : 'Trading closes'} ${dateTime(closeAt)}`}>
            {openMarkets.length > 0
              ? `${staggered ? 'Next close: ' : ''}${timeLeft(closeAt)}`
              : dateTime(closeAt)}
          </div>}
          <div>{event.source.provider === 'horizon' ? event.category || 'Event' : `via ${event.source.provider}`}</div>
        </div>
      </div>
      <h3 style={{ marginTop: '.6rem' }}>{event.title}</h3>
      <ul className="event-outcomes">
        {shown.map(child => (
          <li key={child.position}>
            <span className="event-outcome-name">{child.outcomeLabel}</span>
            {child.market
              ? <>
                  <span className="event-outcome-price">{price(child.market.liquidity.yes.ask)}</span>
                  <span className="small muted">{child.market.status === 'RESOLVED' ? RESULTS[child.market.result] : child.market.status.toLowerCase()}</span>
                </>
              : <span className="small muted">not deployed</span>}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="small muted" style={{ margin: 0 }}>and {hidden} more outcome{hidden === 1 ? '' : 's'}</p>}
      <div className="card-foot row between small muted">
        <span>{event.outcomesComplete ? 'All source outcomes included' : 'A selection of outcomes, not the full set'}</span>
        <span>{usdc(event.stats.collateral)} collateral</span>
      </div>
    </a>
  );
}
