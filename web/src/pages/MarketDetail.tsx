import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Curve, type Market, type Publication, type Quote } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Address, Badge, Card, Empty, ErrorBox, Loading, Notice, TransactionState, ZeroFee, describe, type TxState } from '../components/Ui';
import { dateTime, parseUnits, price, priceUsdc, shares, timeLeft, usdc, USDC_DECIMALS } from '../format';
import { approve, confirm, describeWalletError, send } from '../wallet';

const RESULTS = ['Unresolved', 'YES', 'NO', 'INVALID'];
const SHAPES = ['', 'linear', 'quadratic', 'cubic'];

export function MarketDetail({ market }: { market: string }) {
  const detail = useAsync(() => api.market(market), [market]);
  if (detail.loading) return <Loading rows={6} label="Loading market" />;
  if (detail.error) return <ErrorBox error={detail.error} retry={detail.reload} />;
  const data = detail.data!.market;
  return (
    <div className="stack">
      <div className="row between">
        <a href="#/">← All markets</a>
        <button onClick={detail.reload}>Refresh</button>
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
      <ZeroFee />
      <div className="split">
        <Curves curves={data.curves} />
        {data.status === 'OPEN'
          ? <OrderTicket market={market} book={data.liquidity} onDone={detail.reload} />
          : <Card title="Trading closed"><p className="muted small">This market no longer accepts fills. Resolved markets can be redeemed from <a href="#/holdings">Holdings</a>.</p></Card>}
      </div>
    </div>
  );
}

function Curves({ curves }: { curves: Curve[] }) {
  return (
    <Card title="Order book">
      {curves.length === 0
        ? <Empty title="No open orders">
            <p className="small">Nobody is quoting this market yet. Place a limit order to be the first, and it rests until someone trades against it.</p>
          </Empty>
        : <div className="scroll">
            <table>
              <thead><tr><th>Side</th><th>Type</th><th>Price</th><th>Filled</th><th>Maker</th></tr></thead>
              <tbody>
                {curves.map(curve => {
                  const flags = curve.strategy.flags, isBuy = (flags & 2) !== 0, isYes = (flags & 1) !== 0;
                  const isLimit = curve.strategy.startPrice === curve.strategy.endPrice;
                  return (
                    <tr key={curve.id}>
                      <td><span className={`badge ${isBuy ? 'resolved' : 'no'}`}>{isBuy ? 'BUY' : 'SELL'} {isYes ? 'YES' : 'NO'}</span></td>
                      <td className="small">{isLimit ? 'Limit' : `Curve · ${SHAPES[flags >> 2]}`}</td>
                      <td className="small">{isLimit ? priceUsdc(curve.strategy.startPrice)
                        : `${priceUsdc(curve.strategy.startPrice)} → ${priceUsdc(curve.strategy.endPrice)}`}</td>
                      <td className="small">{shares(curve.filled)} / {shares(curve.strategy.maxShares)}</td>
                      <td className="small"><Address value={curve.maker} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
      <p className="small muted" style={{ marginTop: '.75rem' }}>
        A limit order holds one price. A pricing curve moves its price as it fills — down as a buyer accumulates, up as a seller
        distributes. A maker's USDC is shared with their other markets, so listed depth is an upper bound.
      </p>
    </Card>
  );
}

type Side = { isYes: boolean; isBuy: boolean };
type OrderType = 'market' | 'limit';

const label = (side: Side) => `${side.isBuy ? 'Buy' : 'Sell'} ${side.isYes ? 'YES' : 'NO'}`;

/**
 * One ticket for both ways to trade. A market order takes an existing route immediately; a limit
 * order rests at the maker's own price until someone fills it. Underneath, the limit order is an
 * Aqua order whose start and end prices are equal, which is what the contract treats as fixed.
 */
function OrderTicket({ market, book, onDone }: { market: string; book: Market['liquidity']; onDone: () => void }) {
  const wallet = useWallet();
  const [type, setType] = useState<OrderType>('market');
  const [side, setSide] = useState<Side>({ isYes: true, isBuy: true });
  const outcome = side.isYes ? book.yes : book.no;
  const change = (patch: Partial<Side>) => setSide({ ...side, ...patch });

  return (
    <Card title="Trade">
      <div className="seg tabs">
        {(['market', 'limit'] as const).map(option => (
          <button key={option} className={type === option ? 'active' : ''} onClick={() => setType(option)}>
            {option === 'market' ? 'Market' : 'Limit'}
          </button>
        ))}
      </div>
      <div className="seg">
        <button className={side.isBuy ? 'yes' : ''} onClick={() => change({ isBuy: true })}>Buy</button>
        <button className={!side.isBuy ? 'no' : ''} onClick={() => change({ isBuy: false })}>Sell</button>
      </div>
      <div className="seg">
        <button className={side.isYes ? 'active' : ''} onClick={() => change({ isYes: true })}>YES</button>
        <button className={!side.isYes ? 'active' : ''} onClick={() => change({ isYes: false })}>NO</button>
      </div>
      <div className="book small muted">
        <span>Best ask <strong>{price(outcome.ask)}</strong></span>
        <span>Best bid <strong>{price(outcome.bid)}</strong></span>
        <span>{shares(outcome.availableShares)} offered</span>
      </div>
      {type === 'market'
        ? <MarketOrder market={market} side={side} account={wallet.account} onDone={onDone} onSwitchToLimit={() => setType('limit')} />
        : <LimitOrder market={market} side={side} account={wallet.account} book={outcome} onDone={onDone} />}
      {!wallet.account && (
        <button className="primary" style={{ width: '100%', marginTop: '.6rem' }} onClick={() => void wallet.connect()}>Connect wallet</button>
      )}
      <p className="small muted" style={{ marginTop: '.75rem', marginBottom: 0 }}>
        Need a price that moves as the order fills?{' '}
        <a href={`#/publish?market=${market}&side=${side.isYes ? 'yes' : 'no'}&direction=${side.isBuy ? 'buy' : 'sell'}`}>Publish a pricing curve</a>.
      </p>
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

  // A market order prices itself as you type, the way an exchange ticket does. The request is
  // debounced because each quote refreshes chain state and simulates the whole route.
  useEffect(() => {
    setQuote(undefined); setError(undefined); setTx({ phase: 'idle' });
    if (!account || shareAmount.error || !shareAmount.value) return;
    const shares = shareAmount.value;
    let cancelled = false;
    setPending(true);
    const timer = setTimeout(() => {
      api.quote({ market, account, recipient: account, isYes: side.isYes, isBuy: side.isBuy, shares: shares.toString(), slippageBps })
        .then(result => { if (!cancelled) setQuote(result); },
          issue => {
            if (cancelled) return;
            setError(issue instanceof ApiError
              ? { code: issue.code, message: describeQuoteError(issue.code) }
              : { code: 'unknown', message: issue instanceof Error ? issue.message : 'Pricing failed.' });
          })
        .finally(() => { if (!cancelled) setPending(false); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); setPending(false); clearTimeout(timer); };
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
