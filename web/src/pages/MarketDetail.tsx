import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Curve, type Quote } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Address, Badge, Card, Empty, ErrorBox, Loading, Notice, TransactionState, ZeroFee, type TxState } from '../components/Ui';
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
        <Curves market={market} curves={data.curves} />
        {data.status === 'OPEN'
          ? <OrderTicket market={market} hasCurves={data.curves.length > 0} onDone={detail.reload} />
          : <Card title="Trading closed"><p className="muted small">This market no longer accepts fills. Resolved markets can be redeemed from <a href="#/holdings">Holdings</a>.</p></Card>}
      </div>
    </div>
  );
}

function Curves({ market, curves }: { market: string; curves: Curve[] }) {
  return (
    <Card title="Live curves" actions={<a className="small" href={`#/publish?market=${market}`}>Publish a curve</a>}>
      {curves.length === 0
        ? <Empty title="No live curves">
            <p className="small">Nobody has published executable liquidity here yet. Publishing a buy curve funds complementary minting; publishing a sell curve offers outcomes you already hold.</p>
          </Empty>
        : <div className="scroll">
            <table>
              <thead><tr><th>Maker</th><th>Direction</th><th>Prices</th><th>Shape</th><th>Filled</th></tr></thead>
              <tbody>
                {curves.map(curve => {
                  const flags = curve.strategy.flags, isBuy = (flags & 2) !== 0, isYes = (flags & 1) !== 0;
                  return (
                    <tr key={curve.id}>
                      <td><Address value={curve.maker} /></td>
                      <td><span className={`badge ${isYes ? 'resolved' : 'no'}`}>{isBuy ? 'BUY' : 'SELL'} {isYes ? 'YES' : 'NO'}</span></td>
                      <td>{priceUsdc(curve.strategy.startPrice)} → {priceUsdc(curve.strategy.endPrice)}</td>
                      <td>{SHAPES[flags >> 2]}</td>
                      <td>{shares(curve.filled)} / {shares(curve.strategy.maxShares)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
      <p className="small muted" style={{ marginTop: '.75rem' }}>
        Buy curves decline as the maker accumulates; sell curves rise as inventory leaves. Equal endpoints are a fixed-price limit order.
        A maker's USDC allocation is shared with their other markets, so indexed depth is an upper bound.
      </p>
    </Card>
  );
}

type Ticket = { isYes: boolean; isBuy: boolean; size: string; slippageBps: number };

function OrderTicket({ market, hasCurves, onDone }: { market: string; hasCurves: boolean; onDone: () => void }) {
  const wallet = useWallet();
  const [ticket, setTicket] = useState<Ticket>({ isYes: true, isBuy: true, size: '1', slippageBps: 50 });
  const [quote, setQuote] = useState<Quote | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer); }, []);
  const expired = quote ? quote.deadline <= now : false;
  const sizeError = useMemo(() => {
    try { const value = parseUnits(ticket.size, USDC_DECIMALS); return value < 1_000_000n ? 'Minimum order size is 1 share.' : undefined; }
    catch (issue) { return issue instanceof Error ? issue.message : 'Invalid size.'; }
  }, [ticket.size]);

  const requestQuote = async () => {
    setError(undefined); setQuote(undefined); setTx({ phase: 'idle' });
    if (!wallet.account) { setError({ code: 'wallet', message: 'Connect a wallet to price an order against your balances.' }); return; }
    if (sizeError) return;
    setPending(true);
    try {
      setQuote(await api.quote({ market, account: wallet.account, recipient: wallet.account, isYes: ticket.isYes, isBuy: ticket.isBuy,
        shares: parseUnits(ticket.size, USDC_DECIMALS).toString(), slippageBps: ticket.slippageBps }));
    } catch (issue) {
      setError(issue instanceof ApiError
        ? { code: issue.code, message: describeQuoteError(issue.code) }
        : { code: 'unknown', message: issue instanceof Error ? issue.message : 'Quote failed.' });
    } finally { setPending(false); }
  };

  const run = async (action: 'approve' | 'execute') => {
    if (!wallet.account || !quote) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(wallet.account, quote.approval.token, quote.approval.spender, quote.approval.amount)
        : await send(wallet.account, quote.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(wallet.account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted on chain. Request a new quote.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'approve') await requestQuote(); else { setQuote(undefined); onDone(); }
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  return (
    <Card title="Order">
      <div className="row" style={{ marginBottom: '.75rem' }}>
        <button className={ticket.isYes ? 'yes' : ''} onClick={() => { setTicket({ ...ticket, isYes: true }); setQuote(undefined); }}>YES</button>
        <button className={!ticket.isYes ? 'no' : ''} onClick={() => { setTicket({ ...ticket, isYes: false }); setQuote(undefined); }}>NO</button>
        <span style={{ flex: 1 }} />
        <button className={ticket.isBuy ? 'primary' : ''} onClick={() => { setTicket({ ...ticket, isBuy: true }); setQuote(undefined); }}>Buy</button>
        <button className={!ticket.isBuy ? 'primary' : ''} onClick={() => { setTicket({ ...ticket, isBuy: false }); setQuote(undefined); }}>Sell</button>
      </div>
      <div className="field">
        <label htmlFor="size">Shares</label>
        <input id="size" inputMode="decimal" value={ticket.size} onChange={event => { setTicket({ ...ticket, size: event.target.value }); setQuote(undefined); }} />
        {sizeError ? <div className="error">{sizeError}</div> : <div className="hint">One share pays 1 USDC if that outcome wins.</div>}
      </div>
      <div className="field">
        <label htmlFor="slippage">Slippage tolerance</label>
        <select id="slippage" value={ticket.slippageBps} onChange={event => { setTicket({ ...ticket, slippageBps: Number(event.target.value) }); setQuote(undefined); }}>
          {[10, 50, 100, 300].map(value => <option key={value} value={value}>{value / 100}%</option>)}
        </select>
      </div>
      {!ticket.isBuy && (
        <Notice kind="info">
          Selling here fills against resting buy curves. To offer your outcomes at your own prices instead,{' '}
          <a href={`#/publish?market=${market}&side=${ticket.isYes ? 'yes' : 'no'}&direction=sell`}>publish a sell curve</a>.
        </Notice>
      )}
      <div className="row" style={{ margin: '.75rem 0' }}>
        <button className="primary" onClick={() => void requestQuote()} disabled={pending || Boolean(sizeError)}>
          {pending ? 'Pricing…' : 'Get quote'}
        </button>
        {!wallet.account && <button onClick={() => void wallet.connect()}>Connect wallet</button>}
      </div>
      {error && (error.code === 'quote_unavailable_refresh_or_check_liquidity'
        ? <NoLiquidity market={market} ticket={ticket} reason="No published curve can fill that order right now." />
        : <Notice kind="error">{error.message}</Notice>)}
      {!hasCurves && !error && !quote && (
        <NoLiquidity market={market} ticket={ticket} reason="Nobody has published liquidity in this market yet, so there is nothing to quote against." />
      )}
      {quote && <QuoteView quote={quote} ticket={ticket} expired={expired} secondsLeft={quote.deadline - now} tx={tx} onRun={run} onRequote={() => void requestQuote()} />}
    </Card>
  );
}

function QuoteView({ quote, ticket, expired, secondsLeft, tx, onRun, onRequote }: {
  quote: Quote; ticket: Ticket; expired: boolean; secondsLeft: number; tx: TxState;
  onRun: (action: 'approve' | 'execute') => Promise<void>; onRequote: () => void;
}) {
  const busy = tx.phase === 'signing' || tx.phase === 'pending';
  return (
    <div className="stack" style={{ marginTop: '.75rem' }}>
      <dl className="kv">
        <dt>{ticket.isBuy ? 'You pay' : 'You receive'}</dt><dd><strong>{usdc(quote.usdc)}</strong></dd>
        <dt>{ticket.isBuy ? 'You receive' : 'You deliver'}</dt><dd><strong>{shares(quote.shares)} {ticket.isYes ? 'YES' : 'NO'}</strong></dd>
        <dt>{ticket.isBuy ? 'Maximum spend' : 'Minimum proceeds'}</dt><dd>{usdc(quote.limit)}</dd>
        <dt>Fees</dt><dd>maker {quote.fees.maker}% · taker {quote.fees.taker}% · routing {quote.fees.routing}% · protocol {quote.fees.protocol}%</dd>
        <dt>Route</dt><dd>{quote.legs.length} of at most {quote.search.fillLimit} atomic fills, settled in one transaction</dd>
        <dt>State</dt><dd>chain block {quote.snapshot.block}, indexed block {quote.snapshot.indexedBlock}</dd>
      </dl>
      {expired
        ? <Notice kind="warn">This quote expired. <button className="link" onClick={onRequote}>Request a new one</button>.</Notice>
        : <p className="small muted">Quote valid for {Math.max(0, secondsLeft)}s. It is enforced on-chain by the limit and deadline.</p>}
      {quote.simulation === 'insufficient_balance' && <Notice kind="warn">This account cannot fund the route. Reduce the size or add {ticket.isBuy ? 'test USDC' : 'outcome tokens'}.</Notice>}
      {quote.simulation === 'approval_required' && <Notice kind="warn">One approval is needed before the route can be simulated and executed.</Notice>}
      {quote.simulation === 'passed' && <Notice kind="ok">The complete route was simulated successfully at block {quote.snapshot.block}.</Notice>}
      <TransactionState state={tx} />
      <div className="row">
        {quote.simulation === 'approval_required' && (
          <button className="primary" disabled={busy || expired} onClick={() => void onRun('approve')}>Approve {ticket.isBuy ? 'USDC' : 'outcome tokens'}</button>
        )}
        <button className={ticket.isYes ? 'yes' : 'no'} disabled={busy || expired || quote.simulation !== 'passed'} onClick={() => void onRun('execute')}>
          {ticket.isBuy ? `Buy ${ticket.isYes ? 'YES' : 'NO'}` : `Sell ${ticket.isYes ? 'YES' : 'NO'}`}
        </button>
      </div>
    </div>
  );
}

/**
 * A market with no executable curve is a normal state, not a failure. The useful next step is to
 * publish the liquidity yourself, at prices you choose, so the invitation names that directly.
 */
function NoLiquidity({ market, ticket, reason }: { market: string; ticket: Ticket; reason: string }) {
  const side = ticket.isYes ? 'yes' : 'no';
  const direction = ticket.isBuy ? 'buy' : 'sell';
  return (
    <Notice kind="warn">
      <p style={{ margin: '0 0 .5rem' }}>
        {reason} You can publish your own {ticket.isBuy ? 'bid' : 'offer'} for {ticket.isYes ? 'YES' : 'NO'} and wait for a counterparty,
        instead of taking someone else's price.
      </p>
      <div className="row">
        <a className="button" href={`#/publish?market=${market}&side=${side}&direction=${direction}&type=limit`}>
          Place a limit order
        </a>
        <a className="button" href={`#/publish?market=${market}&side=${side}&direction=${direction}`}>
          Publish a curve
        </a>
      </div>
    </Notice>
  );
}

function describeQuoteError(code: string): string {
  if (code === 'quote_unavailable_refresh_or_check_liquidity') return 'No executable route was found for this size. Try a smaller order, or publish your own curve.';
  if (code === 'quote_capacity') return 'The quote service is busy. Try again in a moment.';
  return code.replace(/_/g, ' ');
}
