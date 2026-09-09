import type { BookLevel, OutcomeBook } from '../api';
import { price as percent, priceUsdc, shares } from '../format';

/**
 * One ladder for the selected outcome. Orders on the other outcome are restated here at
 * `1 - price`: a resting buy of the other side is an ask for this one, and a resting sell of it
 * is a bid. Levels that would need sell-and-merge routing are marked, because this release
 * cannot fill them.
 */
export function OrderBook({ book, isYes, onSelect }: { book: OutcomeBook; isYes: boolean; onSelect: (isYes: boolean) => void }) {
  const deepest = Math.max(1, ...[...book.asks, ...book.bids].map(level => Number(BigInt(level.shares))));
  const deferred = [...book.asks, ...book.bids].some(level => !level.executable);
  const outcome = isYes ? 'YES' : 'NO';
  return (
    <div className="stack">
      <div className="seg">
        <button className={isYes ? 'active' : ''} onClick={() => onSelect(true)}>YES</button>
        <button className={!isYes ? 'active' : ''} onClick={() => onSelect(false)}>NO</button>
      </div>
      <div className="book-head small muted">
        <span>Price ({outcome})</span><span className="right">Shares</span><span className="right">Orders</span>
      </div>
      <div className="ladder">
        {book.asks.length === 0
          ? <p className="small muted empty-side">No one is offering {outcome}.</p>
          : [...book.asks].reverse().map(level => <Level key={`a${level.price}${level.executable}`} level={level} kind="ask" deepest={deepest} />)}
        <div className="spread small">
          {book.spread === null
            ? <span className="muted">No two-sided market yet</span>
            : <><span className="muted">Spread</span> <strong>{percent(book.spread)}</strong></>}
        </div>
        {book.bids.length === 0
          ? <p className="small muted empty-side">No one is bidding for {outcome}.</p>
          : book.bids.map(level => <Level key={`b${level.price}${level.executable}`} level={level} kind="bid" deepest={deepest} />)}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {outcome === 'YES' ? 'NO' : 'YES'} orders appear here at one minus their price.
        {deferred && ' Levels marked “merge” restate a resting sell of the other outcome; filling one needs sell-and-merge routing, which this release does not support yet.'}
        {' '}A curve moves its price as it fills, so a level shows its price now.
      </p>
    </div>
  );
}

function Level({ level, kind, deepest }: { level: BookLevel; kind: 'ask' | 'bid'; deepest: number }) {
  const width = `${Math.min(100, (Number(BigInt(level.shares)) / deepest) * 100)}%`;
  return (
    <div className={`level ${kind}${level.executable ? '' : ' deferred'}`} title={`${level.orders} order${level.orders === 1 ? '' : 's'} · ${level.source}`}>
      <span className="depth" style={{ width }} />
      <span className="price">{priceUsdc(level.price)}</span>
      <span className="right">{shares(level.shares)}</span>
      <span className="right muted">{level.executable ? level.orders : 'merge'}</span>
    </div>
  );
}
