import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type MakerCurve, type Market, type Position, type Publication, type Quote } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Address, Badge, Card, ErrorBox, Fill, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { isLive, useCancelCurve } from '../orders';
import { dateTime, parseUnits, price, priceUsdc, shares, timeLeft, usdc, USDC_DECIMALS } from '../format';
import { OrderBook } from '../components/OrderBook';
import { CurveLiquidity } from '../components/CurveLiquidity';
import { CurveOrder } from '../components/CurveOrder';
import { separate } from '../curve';
import { approve, confirm, describeWalletError, send } from '../wallet';

const RESULTS = ['Unresolved', 'YES', 'NO', 'INVALID'];

export function MarketDetail({ market, query }: { market: string; query: URLSearchParams }) {
  const detail = useAsync(() => api.market(market), [market]);
  const account = useWallet().account;
  // Deep-link parameters are read once, at mount. `query` is a fresh object on every render, so
  // anything that watched it would never settle; `App` keys this component on the address, which is
  // what makes these initializers run again on the way to a different market.
  const [opening] = useState(() => ({
    type: (query.get('ticket') === 'limit' ? 'limit' : query.get('ticket') === 'curve' ? 'curve' : 'market') as OrderType,
    isYes: query.get('side') !== 'no',
    isBuy: query.get('direction') !== 'sell',
  }));
  // What this account already has in this market: the orders it is resting here, and the outcome
  // tokens it holds. Both come from endpoints that cover every market, filtered to this one.
  const mine = useAsync(async () => {
    if (!account) return { orders: [] as MakerCurve[], position: undefined as Position | undefined };
    const [published, held] = await Promise.all([api.makerCurves(account), api.positions(account)]);
    const here = (id: string) => id.toLowerCase() === market.toLowerCase();
    return { orders: published.curves.filter(curve => here(curve.market)), position: held.positions.find(p => here(p.market)) };
  }, [account, market]);
  const [isYes, setIsYes] = useState(opening.isYes);
  if (detail.loading) return <Loading rows={6} label="Loading market" />;
  if (detail.error) return <ErrorBox error={detail.error} retry={detail.reload} />;
  const data = detail.data!.market;
  // The same split the API makes: fixed-price orders feed the ladder, curves feed the chart.
  const resting = separate(data.curves, isYes);
  const refresh = () => { detail.reload(); mine.reload(); };
  return (
    <div className="stack">
      <div className="row between">
        <a href="#/">← All markets</a>
        <button onClick={refresh}>Refresh</button>
      </div>
      <Card>
        <div className="row between">
          <Badge kind={data.status === 'OPEN' ? 'open' : data.status === 'RESOLVED' ? 'resolved' : 'closed'}>
            {data.status === 'RESOLVED' ? `Resolved ${RESULTS[data.result]}` : data.status}
          </Badge>
          <span className="small muted">{data.status === 'OPEN' ? `Closes ${dateTime(data.closeAt)} · ${timeLeft(data.closeAt)}` : `Closed ${dateTime(data.closeAt)}`}</span>
        </div>
        <h1 style={{ marginTop: '.6rem' }}>{data.question}</h1>
        <div className="prices">
          <div className="price-tile yes">
            <div className="label">Buy YES</div><div className="value">{price(data.liquidity.yes.ask)}</div>
            <div className="small muted">{priceUsdc(data.liquidity.yes.ask)} · best bid {price(data.liquidity.yes.bid)}</div>
          </div>
          <div className="price-tile no">
            <div className="label">Buy NO</div><div className="value">{price(data.liquidity.no.ask)}</div>
            <div className="small muted">{priceUsdc(data.liquidity.no.ask)} · best bid {price(data.liquidity.no.bid)}</div>
          </div>
        </div>
        <dl className="kv">
          <dt>Resolution rules</dt><dd>{data.rules}</dd>
          <dt>Evidence source</dt><dd>{data.evidenceSource}</dd>
          <dt>Resolver</dt><dd><Address value={data.resolver} /> (disclosed, centralized)</dd>
          <dt>Collateral</dt><dd>{usdc(data.collateral)}</dd>
          <dt>YES / NO token</dt><dd><Address value={data.yesToken} /> · <Address value={data.noToken} /></dd>
          {data.result !== 0 && <><dt>Evidence</dt><dd>{data.resolutionEvidence}</dd></>}
        </dl>
      </Card>
      <div className="split">
        <div className="stack">
          {/* Both cards read the outcome chosen in the trade ticket; they carry no selector of their own. */}
          <Card title={`Limit orders · ${isYes ? 'YES' : 'NO'}`}>
            <OrderBook book={isYes ? detail.data!.book.yes : detail.data!.book.no} isYes={isYes} curves={resting.curves.length} />
          </Card>
          <Card
            title={`Curve liquidity · ${isYes ? 'YES' : 'NO'}`}
            actions={<span className="count" aria-label={`${resting.curves.length} active curves`}>{resting.curves.length}</span>}
          >
            <p className="small muted" style={{ marginTop: 0 }}>
              Each line is one order repricing as it fills, from where it stands now to the end of what it has left.
            </p>
            <CurveLiquidity curves={data.curves} isYes={isYes} tradable={data.status === 'OPEN'} />
          </Card>
        </div>
        <div className="stack">
          {data.status === 'OPEN'
            ? <OrderTicket market={market} book={data.liquidity} isYes={isYes} onOutcome={setIsYes}
                account={account} position={mine.data?.position} onDone={refresh} opening={opening} />
            : <Card title="Trading closed">
                <p className="muted small">This market no longer accepts fills. Resolved markets can be redeemed from <a href="#/holdings">Portfolio</a>.</p>
                {/* The ticket is what normally chooses the outcome, so a closed market lends its selector. */}
                <OutcomeChoice isYes={isYes} onOutcome={setIsYes} />
              </Card>}
          {account && (mine.data?.orders.length ?? 0) > 0 && (
            <YourOrders orders={mine.data!.orders} account={account} onDone={refresh} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The outcome the limit-order and curve cards are read through. It normally rides in the trade
 * ticket, which is also where a trader picks the outcome to trade; a closed market has no ticket,
 * so it renders this on its own rather than leaving the book stuck on YES.
 */
function OutcomeChoice({ isYes, onOutcome }: { isYes: boolean; onOutcome: (value: boolean) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Outcome">
      <button role="radio" aria-checked={isYes} className={isYes ? 'active' : ''} onClick={() => onOutcome(true)}>YES</button>
      <button role="radio" aria-checked={!isYes} className={!isYes ? 'active' : ''} onClick={() => onOutcome(false)}>NO</button>
    </div>
  );
}

type Side = { isYes: boolean; isBuy: boolean };
type OrderType = 'market' | 'limit' | 'curve';

const label = (side: Side) => `${side.isBuy ? 'Buy' : 'Sell'} ${side.isYes ? 'YES' : 'NO'}`;
const TABS: { key: OrderType; label: string }[] = [
  { key: 'market', label: 'Market' }, { key: 'limit', label: 'Limit' }, { key: 'curve', label: 'Curve' },
];

/**
 * One ticket for all three ways to trade, in order of how much the maker gets to say. A market
 * order takes an existing route immediately; a limit order rests at one price until someone fills
 * it; a curve rests across a range and reprices itself as it fills. Underneath they are the same
 * Aqua order — a limit order is simply the one whose start and end prices are equal — which is why
 * they belong on one control rather than on separate pages.
 */
function OrderTicket({ market, book, isYes, onOutcome, account, position, onDone, opening }: {
  market: string; book: Market['liquidity']; isYes: boolean; onOutcome: (isYes: boolean) => void;
  account?: string; position?: Position; onDone: () => void;
  opening: { type: OrderType; isBuy: boolean };
}) {
  const wallet = useWallet();
  const [type, setType] = useState<OrderType>(opening.type);
  const [isBuy, setIsBuy] = useState(opening.isBuy);
  const side: Side = { isYes, isBuy };
  const outcome = isYes ? book.yes : book.no;

  return (
    <Card title="Trade">
      <div className="seg tabs" role="radiogroup" aria-label="Order type">
        {TABS.map(tab => (
          <button key={tab.key} role="radio" aria-checked={type === tab.key}
            className={type === tab.key ? 'active' : ''} onClick={() => setType(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="seg">
        <button className={isBuy ? 'yes' : ''} onClick={() => setIsBuy(true)}>Buy</button>
        <button className={!isBuy ? 'no' : ''} onClick={() => setIsBuy(false)}>Sell</button>
      </div>
      <OutcomeChoice isYes={isYes} onOutcome={onOutcome} />
      <div className="book small muted">
        <span>Best ask <strong>{price(outcome.ask)}</strong></span>
        <span>Best bid <strong>{price(outcome.bid)}</strong></span>
        <span>{shares(outcome.availableShares)} offered</span>
      </div>
      {account && (
        <p className="small muted" style={{ marginTop: '-.4rem' }}>
          {position
            ? <>You hold <strong>{shares(position.yes)} YES</strong> · <strong>{shares(position.no)} NO</strong> here.</>
            : 'You hold no outcome tokens in this market, so there is nothing to sell yet.'}
        </p>
      )}
      {type === 'market' && <MarketOrder market={market} side={side} account={account} onDone={onDone} onSwitchToLimit={() => setType('limit')} />}
      {type === 'limit' && <LimitOrder market={market} side={side} account={account} book={outcome} onDone={onDone} />}
      {type === 'curve' && <CurveOrder market={market} side={side} account={account} book={outcome} onDone={onDone} />}
      {!account && (
        <button className="primary" style={{ width: '100%', marginTop: '.6rem' }} onClick={() => void wallet.connect()}>Connect wallet</button>
      )}
      {type === 'curve' && (
        <p className="small muted" style={{ marginTop: '.75rem', marginBottom: 0 }}>
          A curve rests across a range of prices and moves through it as it fills.{' '}
          <a href="#/curves">How pricing curves work</a>.
        </p>
      )}
    </Card>
  );
}

/**
 * The account's own resting orders in this market. Live ones are shown and can be cancelled here;
 * anything filled or closed is history and belongs in the Portfolio, which this links to.
 */
function YourOrders({ orders, account, onDone }: { orders: MakerCurve[]; account: string; onDone: () => void }) {
  const { cancel, busy, tx, error } = useCancelCurve(account, onDone);
  const live = orders.filter(isLive);
  const rest = orders.length - live.length;
  return (
    <Card
      title={<>Your orders <span className="count">{live.length}</span></>}
      actions={<a className="small" href="#/holdings?tab=orders">All orders</a>}
    >
      {error && <Notice kind="error">{error}</Notice>}
      <TransactionState state={tx} />
      {live.map(curve => (
        <div key={curve.orderHash} className="own-order">
          <div className="row between">
            <span className={`badge ${curve.direction === 'BUY' ? 'resolved' : 'no'}`}>{curve.direction} {curve.side}</span>
            <span className="mono small">
              {curve.isLimit ? priceUsdc(curve.startPrice) : `${priceUsdc(curve.startPrice)} → ${priceUsdc(curve.endPrice)}`}
            </span>
          </div>
          <Fill filled={curve.filled} total={curve.maxShares} />
          <div className="row between small muted">
            <span>{shares(curve.filled)} / {shares(curve.maxShares)} filled</span>
            {curve.cancellable && (
              <button className="link" disabled={busy !== undefined} onClick={() => void cancel(curve)}>
                {busy === curve.orderHash ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      ))}
      {live.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing resting here right now.</p>}
      {rest > 0 && (
        <p className="small muted" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
          {rest} filled or closed order{rest === 1 ? '' : 's'} in this market · <a href="#/holdings?tab=orders">see Portfolio</a>
        </p>
      )}
    </Card>
  );
}

/** Takes the best executable route now. The quote it shows is the one the wallet will sign. */
function MarketOrder({ market, side, account, onDone, onSwitchToLimit }: {
  market: string; side: Side; account?: string; onDone: () => void; onSwitchToLimit: () => void;
}) {
  const [size, setSize] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<Quote | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer); }, []);

  const shareAmount = useMemo(() => {
    try {
      const value = parseUnits(size, USDC_DECIMALS);
      return value < 1_000_000n ? { error: 'Minimum order size is 1 share.' } : { value };
    } catch (issue) { return { error: issue instanceof Error ? issue.message : 'Invalid amount.' }; }
  }, [size]);

  // A market order prices itself as you type, the way an exchange ticket does. Each quote refreshes
  // chain state and simulates the whole route, so requests are debounced and single-flight: while
  // one is running the newest inputs wait for it, then supersede it. Firing on every keystroke
  // would queue work the trader has already moved past and exhaust the service's own capacity.
  const inFlight = useRef(false);
  const wanted = useRef<string | undefined>(undefined);
  useEffect(() => {
    setQuote(undefined); setError(undefined); setTx({ phase: 'idle' });
    if (!account || shareAmount.error || !shareAmount.value) { wanted.current = undefined; return; }
    const request = { market, account, recipient: account, isYes: side.isYes, isBuy: side.isBuy,
      shares: shareAmount.value.toString(), slippageBps };
    const key = JSON.stringify(request);
    wanted.current = key;
    setPending(true);
    const run = async () => {
      if (inFlight.current || wanted.current !== key) return;
      inFlight.current = true;
      try {
        const result = await api.quote(request);
        if (wanted.current === key) { setQuote(result); setPending(false); }
      } catch (issue) {
        if (wanted.current === key) {
          setError(issue instanceof ApiError
            ? { code: issue.code, message: describeQuoteError(issue.code) }
            : { code: 'unknown', message: issue instanceof Error ? issue.message : 'Pricing failed.' });
          setPending(false);
        }
      } finally {
        inFlight.current = false;
        if (wanted.current !== key) void run();
      }
    };
    const timer = setTimeout(() => void run(), 700);
    return () => clearTimeout(timer);
  }, [market, account, side.isYes, side.isBuy, slippageBps, shareAmount.value?.toString()]);

  const expired = quote ? quote.deadline <= now : false;
  const busy = tx.phase === 'signing' || tx.phase === 'pending';

  const run = async (action: 'approve' | 'execute') => {
    if (!account || !quote) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(account, quote.approval.token, quote.approval.spender, quote.approval.amount)
        : await send(account, quote.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted. Prices moved; try again.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'execute') onDone();
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  return (
    <div className="stack">
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="size">Amount (shares)</label>
        <input id="size" inputMode="decimal" value={size} onChange={event => setSize(event.target.value)} />
        {shareAmount.error ? <div className="error">{shareAmount.error}</div>
          : <div className="hint">One share pays 1 USDC if {side.isYes ? 'YES' : 'NO'} wins.</div>}
      </div>
      <details className="small">
        <summary className="muted">Slippage tolerance: {slippageBps / 100}%</summary>
        <select value={slippageBps} onChange={event => setSlippageBps(Number(event.target.value))} style={{ marginTop: '.35rem' }}>
          {[10, 50, 100, 300].map(value => <option key={value} value={value}>{value / 100}%</option>)}
        </select>
      </details>

      {!account && <Notice kind="info">Connect a wallet to price this order against your balances.</Notice>}
      {account && pending && <p className="small muted">Pricing…</p>}
      {quote && (
        <>
          <dl className="kv total">
            <dt>{side.isBuy ? 'Estimated cost' : 'Estimated proceeds'}</dt><dd><strong>{usdc(quote.usdc)}</strong></dd>
            <dt>Average price</dt><dd>{priceUsdc(Number(BigInt(quote.usdc) * 1_000_000n / BigInt(quote.shares)))}</dd>
            <dt>{side.isBuy ? 'Maximum cost' : 'Minimum proceeds'}</dt><dd>{usdc(quote.limit)}</dd>
            <dt>Fees</dt><dd>0% — no maker, taker, routing or protocol fee</dd>
            <dt>Filled from</dt><dd>{quote.legs.length} order{quote.legs.length === 1 ? '' : 's'}, settled atomically</dd>
          </dl>
          {expired
            ? <Notice kind="warn">This price expired. Change the amount to refresh it.</Notice>
            : <p className="small muted">Price held for {Math.max(0, quote.deadline - now)}s and enforced on chain.</p>}
          {quote.simulation === 'insufficient_balance' && (
            <Notice kind="warn">Not enough {side.isBuy ? 'test USDC' : `${side.isYes ? 'YES' : 'NO'} tokens`} in this wallet for that size.</Notice>
          )}
        </>
      )}
      {error && (error.code === 'quote_unavailable_refresh_or_check_liquidity'
        ? <NoLiquidity side={side} onSwitchToLimit={onSwitchToLimit} />
        : <Notice kind="error">{error.message}</Notice>)}
      <TransactionState state={tx} />
      {quote?.simulation === 'approval_required'
        ? <button className="primary wide" disabled={busy || expired} onClick={() => void run('approve')}>
            Approve {side.isBuy ? 'USDC' : 'outcome tokens'}
          </button>
        : <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={busy || expired || quote?.simulation !== 'passed'}
            onClick={() => void run('execute')}>
            {label(side)}
          </button>}
    </div>
  );
}

/** Rests at the maker's own price. This is a curve with equal endpoints, published through Aqua. */
function LimitOrder({ market, side, account, book, onDone }: {
  market: string; side: Side; account?: string; book: { ask: number | null; bid: number | null }; onDone: () => void;
}) {
  const suggested = ((side.isBuy ? book.bid ?? book.ask : book.ask ?? book.bid) ?? 500_000) / 1_000_000;
  const [price, setPrice] = useState(suggested.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
  const [size, setSize] = useState('10');
  const [prepared, setPrepared] = useState<Publication | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  useEffect(() => { setPrepared(undefined); setTx({ phase: 'idle' }); setError(undefined); }, [price, size, side.isBuy, side.isYes]);

  const micro = Math.round(Number(price) * 1_000_000);
  const priceError = Number.isInteger(micro) && micro > 0 && micro < 1_000_000 ? undefined : 'Enter a price between 0 and 1 USDC.';
  const amount = useMemo(() => {
    try {
      const value = parseUnits(size, USDC_DECIMALS);
      return value < 1_000_000n ? { error: 'Minimum order size is 1 share.' } : { value };
    } catch (issue) { return { error: issue instanceof Error ? issue.message : 'Invalid amount.' }; }
  }, [size]);
  const total = amount.value && !priceError ? (amount.value * BigInt(micro)) / 1_000_000n : undefined;

  const review = async () => {
    if (!account || priceError || amount.error || !amount.value) return;
    setError(undefined); setBusy(true);
    try {
      // Equal start and end prices on the linear preset is exactly a fixed-price order.
      setPrepared(await api.publishCurve({ maker: account, market, isYes: side.isYes, isBuy: side.isBuy,
        startPrice: micro, endPrice: micro, shares: amount.value.toString(), shape: 1 }));
    } catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : 'Could not prepare the order.'); }
    finally { setBusy(false); }
  };

  const run = async (action: 'approve' | 'place') => {
    if (!account || !prepared) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(account, prepared.approval.token, prepared.approval.spender, prepared.approval.amount)
        : await send(account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'approve') await review(); else { setPrepared(undefined); onDone(); }
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  const working = tx.phase === 'signing' || tx.phase === 'pending';
  return (
    <div className="stack">
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="limit-price">Limit price (USDC per share)</label>
        <input id="limit-price" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} />
        {priceError ? <div className="error">{priceError}</div>
          : <div className="hint">{(Number(price) * 100).toFixed(2)}% implied probability</div>}
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="limit-size">Amount (shares)</label>
        <input id="limit-size" inputMode="decimal" value={size} onChange={event => setSize(event.target.value)} />
        {amount.error && <div className="error">{amount.error}</div>}
      </div>
      <dl className="kv total">
        <dt>{side.isBuy ? 'You post' : 'You offer'}</dt>
        <dd><strong>{side.isBuy ? (total === undefined ? '—' : usdc(total)) : `${size || '0'} ${side.isYes ? 'YES' : 'NO'}`}</strong></dd>
        <dt>Fees</dt><dd>0% — no maker, taker, routing or protocol fee</dd>
      </dl>
      <Notice kind="info">
        Your order rests until someone trades against it, and you can cancel it any time from your{' '}
        <a href="#/holdings">portfolio</a>.
        {side.isBuy && ' A resting bid also funds complementary minting for a trader buying the opposite outcome.'}
      </Notice>
      {!account && <Notice kind="info">Connect a wallet to place an order from your own account.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {prepared?.readiness === 'insufficient_balance' && (
        <Notice kind="warn">Not enough {side.isBuy ? 'test USDC' : `${side.isYes ? 'YES' : 'NO'} tokens`} to back this order.</Notice>
      )}
      <TransactionState state={tx} />
      {!prepared
        ? <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={busy || !account || Boolean(priceError) || Boolean(amount.error)}
            onClick={() => void review()}>{busy ? 'Checking…' : `Review ${label(side)}`}</button>
        : prepared.readiness === 'approval_required'
          ? <button className="primary wide" disabled={working} onClick={() => void run('approve')}>
              Approve {side.isBuy ? 'USDC' : 'outcome tokens'} for Aqua
            </button>
          : <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={working || prepared.readiness !== 'ready'}
              onClick={() => void run('place')}>Place limit order</button>}
    </div>
  );
}

/**
 * An empty book is a normal state on a young market. The useful next step is to become the maker,
 * so the invitation switches the ticket rather than sending the trader somewhere else.
 */
function NoLiquidity({ side, onSwitchToLimit }: { side: Side; onSwitchToLimit: () => void }) {
  return (
    <Notice kind="warn">
      <p style={{ margin: '0 0 .5rem' }}>
        Nobody is {side.isBuy ? 'offering' : 'bidding for'} {side.isYes ? 'YES' : 'NO'} at that size right now, so a market order cannot fill.
        Place a limit order at your own price and wait to be filled.
      </p>
      <button onClick={onSwitchToLimit}>Switch to a limit order</button>
    </Notice>
  );
}

function describeQuoteError(code: string): string {
  if (code === 'quote_capacity') return 'The pricing service is busy. Try again in a moment.';
  return code.replace(/_/g, ' ');
}
