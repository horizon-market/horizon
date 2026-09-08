import { useState } from 'react';
import { api, type Market } from '../api';
import { useAsync } from '../hooks';
import { Badge, Empty, ErrorBox, Loading, ZeroFee } from '../components/Ui';
import { dateTime, price, shares, timeLeft, usdc } from '../format';

const STATUS: Record<Market['status'], 'open' | 'closed' | 'resolved'> = { OPEN: 'open', CLOSED: 'closed', RESOLVED: 'resolved' };
const RESULTS = ['Unresolved', 'YES', 'NO', 'INVALID'];

export function Markets() {
  const listing = useAsync(() => api.markets(), []);
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  if (listing.loading) return <Loading rows={6} label="Loading markets" />;
  if (listing.error) return <ErrorBox error={listing.error} retry={listing.reload} />;
  const data = listing.data!;
  const visible = data.markets.filter(market => filter === 'all' || (filter === 'open' ? market.status === 'OPEN' : market.status !== 'OPEN'));
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
        Discovery reads The Graph at indexed block {data.indexedBlock}. Prices and depth below are indexed estimates;
        every order is re-checked and simulated against live chain state before you sign.
      </p>
      {visible.length === 0
        ? <Empty title={data.markets.length === 0 ? 'No markets are indexed yet' : 'No markets match this filter'}>
            <p>Create the first one from the <a href="#/create">Create market</a> page.</p>
          </Empty>
        : <div className="grid">{visible.map(market => <MarketCard key={market.id} market={market} />)}</div>}
    </div>
  );
}

const depth = (available: string) => `${shares(available)} share${available === '1000000' ? '' : 's'} available`;

function MarketCard({ market }: { market: Market }) {
  const yes = market.liquidity.yes, no = market.liquidity.no;
  return (
    <a className="card" href={`#/markets/${market.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
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
      <div className="row between small muted">
        <span>{market.liquidity.curves} live curve{market.liquidity.curves === 1 ? '' : 's'}</span>
        <span>{usdc(market.collateral)} collateral</span>
      </div>
    </a>
  );
}
