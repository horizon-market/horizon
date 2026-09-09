import type { BookLevel, OutcomeBook } from '../api';
import { USDC_DECIMALS, formatUnits, price as percent, priceUsdc, shares } from '../format';

/**
 * One ladder for the outcome chosen in the order ticket; this component has no selector of its
 * own. Orders on the other outcome are restated here at `1 - price`: a resting buy of the other
 * side is an ask for this one, and a resting sell of it is a bid. Levels that would need
 * sell-and-merge routing are marked, because this release cannot fill them.
 */
export function OrderBook({ book, isYes }: { book: OutcomeBook; isYes: boolean }) {
  const deepest = Math.max(1, ...[...book.asks, ...book.bids].map(level => Number(BigInt(level.shares))));
  const deferred = [...book.asks, ...book.bids].some(level => !level.executable);
  const outcome = isYes ? 'YES' : 'NO';
  return (
    <div className="stack">
      <div className="book-head small muted">
        <span>Price ({outcome})</span><span className="right">Shares</span><span className="right">Total</span>
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

/**
 * Total is what this one level is worth: its price times the shares resting at it. The number of
 * orders behind a level moved into the row's tooltip, where it belongs — it never decided anything.
 */
const levelTotal = (level: BookLevel) =>
  formatUnits(BigInt(level.shares) * BigInt(level.price) / 1_000_000n, USDC_DECIMALS);

function Level({ level, kind, deepest }: { level: BookLevel; kind: 'ask' | 'bid'; deepest: number }) {
  const width = `${Math.min(100, (Number(BigInt(level.shares)) / deepest) * 100)}%`;
  return (
    <div className={`level ${kind}${level.executable ? '' : ' deferred'}`}
      title={`${shares(level.shares)} at ${priceUsdc(level.price)} · ${level.orders} order${level.orders === 1 ? '' : 's'} · ${level.source}`}>
      <span className="depth" style={{ width }} />
      <span className="price">
        {priceUsdc(level.price)}
        {!level.executable && <span className="flag">merge</span>}
      </span>
      <span className="right">{shares(level.shares)}</span>
      <span className="right">{levelTotal(level)}</span>
    </div>
  );
}
