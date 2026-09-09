import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Publication } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Card, ErrorBox, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { CurveChart } from '../components/CurveChart';
import { averagePrice, priceAt, totalCost, type CurvePreview, type CurveShape } from '../curve';
import { parseUnits, priceUsdc, shares as formatShares, usdc, USDC_DECIMALS } from '../format';
import { approve, confirm, describeWalletError, send } from '../wallet';

const SHAPES = [
  { value: 1, label: 'Linear (alpha 1)', hint: 'Price moves evenly with the filled fraction.' },
  { value: 2, label: 'Quadratic (alpha 2)', hint: 'Price holds near the start, then moves faster.' },
  { value: 3, label: 'Cubic (alpha 3)', hint: 'Price holds near the start longest, then moves sharply.' },
];

type OrderType = 'limit' | 'curve';
type Form = { market: string; type: OrderType; isYes: boolean; isBuy: boolean; startPrice: string; endPrice: string; size: string; shape: number };

export function PublishCurve({ query }: { query: URLSearchParams }) {
  const wallet = useWallet();
  const listing = useAsync(() => api.markets(), []);
  const [form, setForm] = useState<Form>(() => {
    const type: OrderType = query.get('type') === 'limit' ? 'limit' : 'curve';
    return {
      market: query.get('market') ?? '', type, isYes: query.get('side') !== 'no', isBuy: query.get('direction') !== 'sell',
      // A limit order is the same order with both endpoints equal, so the price never moves.
      startPrice: '0.50', endPrice: type === 'limit' ? '0.50' : '0.40', size: '10', shape: 1,
    };
  });
  const [prepared, setPrepared] = useState<Publication | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  useEffect(() => {
    if (!form.market && listing.data?.markets.length) {
      const open = listing.data.markets.find(market => market.status === 'OPEN');
      if (open) setForm(current => ({ ...current, market: open.id }));
    }
  }, [listing.data, form.market]);
  useEffect(() => {
    // A buy curve declines as inventory is acquired; a sell curve rises as inventory leaves.
    // Switching direction reflects the end price across the start price, so the shape the maker
    // chose survives instead of collapsing into a flat order.
    setForm(current => {
      if (current.type === 'limit') return current;
      const start = Number(current.startPrice), end = Number(current.endPrice);
      if (Number.isNaN(start) || Number.isNaN(end)) return current;
      if (current.isBuy === (end <= start)) return current;
      const reflected = Math.min(0.999999, Math.max(0.000001, start * 2 - end));
      return { ...current, endPrice: reflected.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') };
    });
  }, [form.isBuy]);

  const problems = useMemo(() => validate(form), [form]);
  // The chart mirrors the contract's integral, so what it shades is what the order will post.
  const curvePreview = useMemo<CurvePreview | undefined>(() => {
    const startPrice = micro(form.startPrice), endPrice = micro(form.endPrice);
    if (![startPrice, endPrice].every(price => Number.isInteger(price) && price > 0 && price < 1_000_000)) return undefined;
    try {
      const shares = parseUnits(form.size, USDC_DECIMALS);
      if (shares < 1_000_000n || shares > 10n ** 15n) return undefined;
      return { isBuy: form.isBuy, startPrice, endPrice, shape: form.shape as CurveShape, shares };
    } catch { return undefined; }
  }, [form]);
  const reset = () => { setPrepared(undefined); setTx({ phase: 'idle' }); setError(undefined); };
  const update = (patch: Partial<Form>) => {
    const next = { ...form, ...patch };
    // Equal endpoints on the linear preset are exactly what the contract treats as a limit order.
    if (next.type === 'limit') { next.endPrice = next.startPrice; next.shape = 1; }
    setForm(next);
    reset();
  };

  const preview = async () => {
    setError(undefined); setPrepared(undefined); setTx({ phase: 'idle' });
    if (!wallet.account) { setError('Connect a wallet to publish a curve from your own account.'); return; }
    if (problems.length) return;
    setBusy(true);
    try {
      setPrepared(await api.publishCurve({
        maker: wallet.account, market: form.market, isYes: form.isYes, isBuy: form.isBuy,
        startPrice: micro(form.startPrice), endPrice: micro(form.endPrice),
        shares: parseUnits(form.size, USDC_DECIMALS).toString(), shape: form.shape,
      }));
    } catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : issue instanceof Error ? issue.message : 'Preparation failed.'); }
    finally { setBusy(false); }
  };

  const run = async (action: 'approve' | 'publish') => {
    if (!wallet.account || !prepared) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(wallet.account, prepared.approval.token, prepared.approval.spender, prepared.approval.amount)
        : await send(wallet.account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(wallet.account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'approve') await preview();
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  if (listing.loading) return <Loading rows={5} label="Loading markets" />;
  if (listing.error) return <ErrorBox error={listing.error} retry={listing.reload} />;
  const open = listing.data!.markets.filter(market => market.status === 'OPEN');

  return (
    <div className="stack">
      <h1>{form.type === 'limit' ? 'Place a limit order' : 'Publish a curve'}</h1>
      <Notice kind="brand">
        <strong>0% trading fees.</strong> Publishing and filling an order costs nothing beyond network gas.
      </Notice>
      <div className="split">
        <Card title={form.type === 'limit' ? 'Limit order' : 'Curve'}>
          {open.length === 0 && <Notice kind="warn">No open markets are indexed yet.</Notice>}
          <div className="field">
            <label htmlFor="market">Market</label>
            <select id="market" value={form.market} onChange={event => update({ market: event.target.value })}>
              <option value="">Select a market…</option>
              {open.map(market => <option key={market.id} value={market.id}>{market.question}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Order type</label>
            <div className="row">
              <button className={form.type === 'limit' ? 'primary' : ''} onClick={() => update({ type: 'limit' })}>Limit order</button>
              <button className={form.type === 'curve' ? 'primary' : ''} onClick={() => update({ type: 'curve', endPrice: form.isBuy ? '0.40' : '0.60' })}>Pricing curve</button>
            </div>
            <div className="hint">
              {form.type === 'limit'
                ? 'One fixed price for every share. It is a curve whose start and end prices are equal, so nothing moves as it fills.'
                : 'A price that moves as the order fills, so you take a better average than a single price would give you.'}
            </div>
          </div>
          <div className="row" style={{ marginBottom: '.75rem' }}>
            <button className={form.isYes ? 'yes' : ''} onClick={() => update({ isYes: true })}>YES</button>
            <button className={!form.isYes ? 'no' : ''} onClick={() => update({ isYes: false })}>NO</button>
            <span style={{ flex: 1 }} />
            <button className={form.isBuy ? 'primary' : ''} onClick={() => update({ isBuy: true })}>Buy</button>
            <button className={!form.isBuy ? 'primary' : ''} onClick={() => update({ isBuy: false })}>Sell</button>
          </div>
          <Notice kind="info">
            {form.isBuy
              ? `A buy ${form.type === 'limit' ? 'order' : 'curve'} posts USDC to acquire ${form.isYes ? 'YES' : 'NO'}${form.type === 'limit' ? ' at one price' : '. Its price declines as it fills'}, and it also funds complementary minting for a trader buying the opposite outcome.`
              : `A sell ${form.type === 'limit' ? 'order' : 'curve'} offers ${form.isYes ? 'YES' : 'NO'} you already hold${form.type === 'limit' ? ' at one price' : '. Its price rises as inventory leaves'}. This is the explicit step that turns holdings into public liquidity.`}
          </Notice>
          <div className="fields" style={{ marginTop: '.75rem' }}>
            <div className="field">
              <label htmlFor="start">{form.type === 'limit' ? 'Limit price (USDC per share)' : 'Start price (USDC per share)'}</label>
              <input id="start" inputMode="decimal" value={form.startPrice} onChange={event => update({ startPrice: event.target.value })} />
              <div className="hint">{describePrice(form.startPrice)}</div>
            </div>
            {form.type === 'curve' && (
              <div className="field">
                <label htmlFor="end">End price (USDC per share)</label>
                <input id="end" inputMode="decimal" value={form.endPrice} onChange={event => update({ endPrice: event.target.value })} />
                <div className="hint">{form.startPrice === form.endPrice ? 'Equal to the start price: this is a limit order.' : describePrice(form.endPrice)}</div>
              </div>
            )}
            <div className="field">
              <label htmlFor="amount">Amount (shares)</label>
              <input id="amount" inputMode="decimal" value={form.size} onChange={event => update({ size: event.target.value })} />
              <div className="hint">Minimum 1 share.</div>
            </div>
            {form.type === 'curve' && (
              <div className="field">
                <label htmlFor="shape">Curve shape</label>
                <select id="shape" value={form.shape} onChange={event => update({ shape: Number(event.target.value) })}>
                  {SHAPES.map(shape => <option key={shape.value} value={shape.value}>{shape.label}</option>)}
                </select>
                <div className="hint">{SHAPES.find(shape => shape.value === form.shape)!.hint}</div>
              </div>
            )}
          </div>
          {curvePreview
            ? <>
                <CurveChart curve={curvePreview} size={curvePreview.shares} />
                <div className="chart-readout">
                  {form.type === 'limit'
                    ? <>
                        <div><div className="label">Price</div><div className="value">{priceUsdc(curvePreview.startPrice)}</div></div>
                        <div><div className="label">Shares</div><div className="value">{formatShares(curvePreview.shares)}</div></div>
                      </>
                    : <>
                        <div><div className="label">Start</div><div className="value">{priceUsdc(curvePreview.startPrice)}</div></div>
                        <div><div className="label">Half filled</div><div className="value">{priceUsdc(priceAt(curvePreview, 0.5))}</div></div>
                        <div><div className="label">End</div><div className="value">{priceUsdc(curvePreview.endPrice)}</div></div>
                        <div><div className="label">Average</div><div className="value">{priceUsdc(averagePrice(curvePreview))}</div></div>
                      </>}
                  <div>
                    <div className="label">{form.isBuy ? 'USDC posted' : 'Full-fill proceeds'}</div>
                    <div className="value">{usdc(totalCost(curvePreview))}</div>
                  </div>
                </div>
              </>
            : <p className="small muted">Enter valid prices and an amount to preview the curve.</p>}
          {problems.length > 0 && <Notice kind="warn"><ul style={{ margin: 0, paddingLeft: '1.1rem' }}>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          <div className="row" style={{ marginTop: '.75rem' }}>
            <button className="primary" disabled={busy || problems.length > 0} onClick={() => void preview()}>
              {busy ? 'Preparing…' : form.type === 'limit' ? 'Review limit order' : 'Review curve'}
            </button>
            {!wallet.account && <button onClick={() => void wallet.connect()}>Connect wallet</button>}
          </div>
        </Card>
        <Card title="Review and publish">
          {!prepared
            ? <p className="muted small">Fill in the curve and choose <em>Review curve</em>. Horizon rebuilds the canonical order through the deployed router and checks your balance and allowance before anything is signed.</p>
            : <div className="stack">
                <dl className="kv">
                  <dt>Order</dt><dd>{form.isBuy ? 'BUY' : 'SELL'} {form.isYes ? 'YES' : 'NO'} · {form.type === 'limit' ? 'limit order' : 'pricing curve'}</dd>
                  <dt>{form.type === 'limit' ? 'Price' : 'Prices'}</dt>
                  <dd>{form.type === 'limit' ? priceUsdc(prepared.strategy.startPrice) : `${priceUsdc(prepared.strategy.startPrice)} → ${priceUsdc(prepared.strategy.endPrice)}`}</dd>
                  <dt>Size</dt><dd>{formatShares(prepared.strategy.maxShares)} shares</dd>
                  <dt>{form.isBuy ? 'USDC budget' : 'Outcome tokens posted'}</dt>
                  <dd>{form.isBuy ? usdc(prepared.amounts[1]!) : `${formatShares(prepared.amounts[0]!)} ${form.isYes ? 'YES' : 'NO'}`}</dd>
                  <dt>Fees</dt><dd>maker {prepared.fees.maker}% · taker {prepared.fees.taker}% · routing {prepared.fees.routing}% · protocol {prepared.fees.protocol}%</dd>
                  <dt>Order hash</dt><dd className="mono">{prepared.orderHash.slice(0, 18)}…</dd>
                </dl>
                <Notice kind="info">{prepared.shared}</Notice>
                {prepared.readiness === 'insufficient_balance' && (
                  <Notice kind="warn">This account does not hold enough {form.isBuy ? 'test USDC' : 'outcome tokens'} to back the curve.</Notice>
                )}
                <TransactionState state={tx} />
                <div className="row">
                  {prepared.readiness === 'approval_required' && (
                    <button className="primary" disabled={tx.phase === 'signing' || tx.phase === 'pending'} onClick={() => void run('approve')}>
                      Approve {form.isBuy ? 'USDC' : 'outcome tokens'} for Aqua
                    </button>
                  )}
                  <button className="primary" disabled={prepared.readiness !== 'ready' || tx.phase === 'signing' || tx.phase === 'pending'} onClick={() => void run('publish')}>
                    {form.type === 'limit' ? 'Place limit order' : 'Publish curve'}
                  </button>
                </div>
                <p className="small muted">
                  Publishing authorizes Aqua to spend from this wallet on this order only. Cancelling with Aqua withdraws the allocation;
                  changing terms requires publishing a new curve.
                </p>
              </div>}
        </Card>
      </div>
    </div>
  );
}

const micro = (value: string) => Math.round(Number(value) * 1_000_000);
const describePrice = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(2)}% implied probability` : 'Enter a price between 0 and 1 USDC.';
};

function validate(form: Form): string[] {
  const problems: string[] = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(form.market)) problems.push('Select a market.');
  for (const [label, value] of [['Start price', form.startPrice], ['End price', form.endPrice]] as const) {
    if (!/^\d?(\.\d{1,6})?$/.test(value.trim()) && !/^\d+(\.\d{1,6})?$/.test(value.trim())) problems.push(`${label} must be a number with at most six decimals.`);
    const units = micro(value);
    if (!Number.isInteger(units) || units <= 0 || units >= 1_000_000) problems.push(`${label} must be strictly between 0 and 1 USDC.`);
  }
  if (form.isBuy && micro(form.endPrice) > micro(form.startPrice)) problems.push('A buy curve cannot end above its start price.');
  if (!form.isBuy && micro(form.endPrice) < micro(form.startPrice)) problems.push('A sell curve cannot end below its start price.');
  try {
    const size = parseUnits(form.size, USDC_DECIMALS);
    if (size < 1_000_000n) problems.push('Publish at least one share.');
    if (size > 10n ** 15n) problems.push('The maximum curve size is 1,000,000,000 shares.');
  } catch (issue) { problems.push(issue instanceof Error ? issue.message : 'Invalid amount.'); }
  return [...new Set(problems)];
}
