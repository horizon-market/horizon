import { useState } from 'react';
import { api, ApiError, type MakerCurve, type Position } from '../api';
import { navigate, useAsync, type Async } from '../hooks';
import { useWallet } from '../App';
import { Card, Empty, ErrorBox, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { cumulative, type CurveShape } from '../curve';
import { dateTime, priceUsdc, shares, timeLeft, usdc } from '../format';
import { confirm, describeWalletError, send } from '../wallet';

/**
 * Two things live here and they have different lifecycles: outcome tokens this account holds,
 * and orders it has published. Each is a tab, and each row states which stage of its life it is
 * in, because what you can do with it — trade, wait, redeem, cancel — follows from that stage.
 */

type PositionState = 'open' | 'awaiting' | 'redeemable' | 'settled';
type OrderState = 'open' | 'filled' | 'closed';

const POSITION_STATES: Record<PositionState, { label: string; badge: 'open' | 'warn' | 'resolved' | 'closed'; hint: string }> = {
  open: { label: 'Open', badge: 'open', hint: 'Trading is still open in this market.' },
  awaiting: { label: 'Awaiting result', badge: 'warn', hint: 'Trading has closed. The disclosed resolver has not submitted a result yet.' },
  redeemable: { label: 'Redeemable', badge: 'resolved', hint: 'Resolved in your favour. Redeem to burn the tokens and take the collateral.' },
  settled: { label: 'No payout', badge: 'closed', hint: 'Resolved against this holding, so it pays nothing.' },
};

const ORDER_STATES: Record<OrderState, { label: string; badge: 'open' | 'resolved' | 'closed' }> = {
  open: { label: 'Open', badge: 'open' },
  filled: { label: 'Filled', badge: 'resolved' },
  closed: { label: 'Closed', badge: 'closed' },
};

const POSITION_FILTERS: [PositionState | 'all', string][] = [
  ['all', 'All'], ['open', 'Open'], ['awaiting', 'Awaiting result'], ['redeemable', 'Redeemable'], ['settled', 'No payout'],
];
const ORDER_FILTERS: [OrderState | 'all', string][] = [
  ['open', 'Open'], ['filled', 'Filled'], ['closed', 'Closed'], ['all', 'All'],
];

// Redeemable first, then whatever still needs watching, then the finished rows.
const POSITION_ORDER: PositionState[] = ['redeemable', 'open', 'awaiting', 'settled'];
const ORDER_ORDER: OrderState[] = ['open', 'filled', 'closed'];

function positionState(position: Position): PositionState {
  if (position.status === 'OPEN') return 'open';
  if (position.status !== 'RESOLVED') return 'awaiting';
  return BigInt(position.redeemableUsdc) > 0n ? 'redeemable' : 'settled';
}

function orderState(curve: MakerCurve): OrderState {
  if (BigInt(curve.remaining) === 0n) return 'filled';
  return curve.active ? 'open' : 'closed';
}

/**
 * What an unfilled buy order still has posted, through the same exact integral the contract uses.
 * These amounts are not additive against a wallet: orders across markets draw on one shared
 * balance, so the total posted can exceed what is actually spendable.
 */
function postedUsdc(curve: MakerCurve): bigint {
  if (curve.direction !== 'BUY') return 0n;
  const preview = {
    isBuy: true, startPrice: curve.startPrice, endPrice: curve.endPrice,
    shape: (curve.shape === 2 || curve.shape === 3 ? curve.shape : 1) as CurveShape,
    shares: BigInt(curve.maxShares),
  };
  return cumulative(preview, BigInt(curve.maxShares)) - cumulative(preview, BigInt(curve.filled));
}

export function Holdings({ query }: { query: URLSearchParams }) {
  const wallet = useWallet();
  const account = wallet.account;
  const tab = query.get('tab') === 'orders' ? 'orders' : 'positions';
  const positions = useAsync(async () => account ? api.positions(account) : { indexedBlock: 0, positions: [] as Position[] }, [account]);
  const orders = useAsync(async () => account ? api.makerCurves(account) : { indexedBlock: 0, curves: [] as MakerCurve[] }, [account]);

  if (!account) {
    return (
      <Card title="Portfolio">
        <Empty title="Connect a wallet to see your positions and orders">
          <p className="small">Balances are read live from the outcome token contracts, not from indexed transfers.</p>
          <button className="primary" onClick={() => void wallet.connect()}>Connect wallet</button>
        </Empty>
      </Card>
    );
  }
  if (positions.loading || orders.loading) return <Loading rows={6} label="Loading portfolio" />;
  const failure = failed(positions) ?? failed(orders);
  if (failure) return <ErrorBox error={failure} retry={() => { positions.reload(); orders.reload(); }} />;

  const held = positions.data!.positions;
  const published = orders.data!.curves;
  const openOrders = published.filter(curve => orderState(curve) === 'open');

  return (
    <div className="stack">
      <div className="row between">
        <h1>Portfolio</h1>
        <button onClick={() => { positions.reload(); orders.reload(); }}>Refresh</button>
      </div>

      <Summary held={held} published={published} />

      <div className="seg tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'positions'} className={tab === 'positions' ? 'active' : ''}
          onClick={() => navigate('/holdings')}>
          Positions <span className="count">{held.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''}
          onClick={() => navigate('/holdings?tab=orders')}>
          Orders <span className="count">{openOrders.length}</span>
        </button>
      </div>

      {tab === 'positions'
        ? <Positions held={held} account={account} onDone={() => { positions.reload(); orders.reload(); }} />
        : <Orders published={published} account={account} onDone={orders.reload} />}
    </div>
  );
}

const failed = <T,>(state: Async<T>) => state.error ?? undefined;

function Summary({ held, published }: { held: Position[]; published: MakerCurve[] }) {
  const redeemable = held.filter(p => positionState(p) === 'redeemable');
  const awaiting = held.filter(p => positionState(p) === 'awaiting').length;
  const open = published.filter(curve => orderState(curve) === 'open');
  const partly = open.filter(curve => BigInt(curve.filled) > 0n).length;
  const claimable = redeemable.reduce((total, p) => total + BigInt(p.redeemableUsdc), 0n);
  const posted = open.reduce((total, curve) => total + postedUsdc(curve), 0n);
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="label">Redeemable now</div>
          <div className="value">{usdc(claimable)}</div>
          <div className="small muted">{redeemable.length} resolved market{redeemable.length === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="label">Positions</div>
          <div className="value">{held.length}</div>
          <div className="small muted">{awaiting} awaiting a result</div>
        </div>
        <div className="stat">
          <div className="label">Open orders</div>
          <div className="value">{open.length}</div>
          <div className="small muted">{partly} partly filled</div>
        </div>
        <div className="stat">
          <div className="label">Posted in open buys</div>
          <div className="value">{usdc(posted)}</div>
          <div className="small muted">across {open.filter(c => c.direction === 'BUY').length} order{open.filter(c => c.direction === 'BUY').length === 1 ? '' : 's'}</div>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Posted amounts are not additive against your wallet: orders in different markets draw on the
        same shared USDC, so a fill in one reduces what the others can still execute.
      </p>
    </>
  );
}

function Positions({ held, account, onDone }: { held: Position[]; account: string; onDone: () => void }) {
  const [filter, setFilter] = useState<PositionState | 'all'>('all');
  const [busy, setBusy] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [error, setError] = useState<string | undefined>();
  const counts = tally(held, positionState);
  const visible = held
    .filter(position => filter === 'all' || positionState(position) === filter)
    .sort((a, b) => POSITION_ORDER.indexOf(positionState(a)) - POSITION_ORDER.indexOf(positionState(b)));

  const redeem = async (position: Position) => {
    setError(undefined); setBusy(position.market); setTx({ phase: 'signing' });
    try {
      const prepared = await api.redeem({ account, market: position.market, recipient: account, yesShares: position.yes, noShares: position.no });
      const hash = await send(account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      setTx(status === 'success' ? { phase: 'confirmed', hash } : { phase: 'error', hash, message: 'The redemption reverted.' });
      if (status === 'success') onDone();
    } catch (issue) {
      if (issue instanceof ApiError) { setError(describe(issue.code)); setTx({ phase: 'idle' }); }
      else setTx({ phase: 'error', message: describeWalletError(issue) });
    } finally { setBusy(undefined); }
  };

  if (held.length === 0) {
    return (
      <Empty title="No outcome tokens yet">
        <p className="small">Buy YES or NO in any open market and the position appears here.</p>
        <a className="button" href="#/">Browse markets</a>
      </Empty>
    );
  }
  return (
    <div className="stack">
      <Notice kind="info">
        Outcome tokens are bound to one market and outcome. Holding them creates no sell offer: publish a
        sell order when you want to sell.
      </Notice>
      <Filters options={POSITION_FILTERS} counts={counts} value={filter} onChange={setFilter} />
      {error && <Notice kind="error">{error}</Notice>}
      <TransactionState state={tx} />
      {visible.length === 0
        ? <Empty title={`No ${POSITION_STATES[filter as PositionState].label.toLowerCase()} positions`} />
        : <Card>
            <div className="scroll">
              <table>
                <thead><tr><th>Market</th><th>YES</th><th>NO</th><th>Payout</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {visible.map(position => {
                    const state = positionState(position);
                    const meta = POSITION_STATES[state];
                    const resolved = position.status === 'RESOLVED';
                    return (
                      <tr key={position.market}>
                        <td>
                          <a href={`#/markets/${position.market}`}>{position.question}</a>
                          <div className="small muted">{position.status === 'OPEN' ? timeLeft(position.closeAt) : dateTime(position.closeAt)}</div>
                        </td>
                        <td className="small">{shares(position.yes)}</td>
                        <td className="small">{shares(position.no)}</td>
                        <td className="small">
                          {resolved ? usdc(position.redeemableUsdc) : <span className="muted">—</span>}
                          {position.result === 'INVALID' && <div className="muted">0.5 USDC per token</div>}
                        </td>
                        <td>
                          <span className={`badge ${meta.badge}`} title={meta.hint}>{meta.label}</span>
                          {resolved && <div className="small muted">resolved {position.result}</div>}
                        </td>
                        <td>
                          {state === 'redeemable'
                            ? <button className="primary" disabled={busy !== undefined} onClick={() => void redeem(position)}>
                                {busy === position.market ? 'Redeeming…' : 'Redeem'}
                              </button>
                            : <a className="button" href={`#/markets/${position.market}`}>{state === 'open' ? 'Trade' : 'View'}</a>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 'var(--space-2)' }}>
              Open means the market is still trading. Awaiting result means trading has closed and the
              disclosed resolver has not submitted one yet. Redeeming burns the tokens and pays out the
              collateral behind them; INVALID pays 0.5 USDC per outcome token.
            </p>
          </Card>}
    </div>
  );
}

function Orders({ published, account, onDone }: { published: MakerCurve[]; account: string; onDone: () => void }) {
  const [filter, setFilter] = useState<OrderState | 'all'>('open');
  const [busy, setBusy] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [error, setError] = useState<string | undefined>();
  const counts = tally(published, orderState);
  const visible = published
    .filter(curve => filter === 'all' || orderState(curve) === filter)
    .sort((a, b) => ORDER_ORDER.indexOf(orderState(a)) - ORDER_ORDER.indexOf(orderState(b)) || b.publishedAt - a.publishedAt);

  const cancel = async (curve: MakerCurve) => {
    setError(undefined); setBusy(curve.orderHash); setTx({ phase: 'signing' });
    try {
      const prepared = await api.cancelCurve({ maker: account, market: curve.market, orderHash: curve.orderHash, outcomeToken: curve.outcomeToken });
      const hash = await send(account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      setTx(status === 'success' ? { phase: 'confirmed', hash } : { phase: 'error', hash, message: 'The cancellation reverted.' });
      if (status === 'success') onDone();
    } catch (issue) {
      if (issue instanceof ApiError) { setError(describe(issue.code)); setTx({ phase: 'idle' }); }
      else setTx({ phase: 'error', message: describeWalletError(issue) });
    } finally { setBusy(undefined); }
  };

  if (published.length === 0) {
    return (
      <Empty title="No orders yet">
        <p className="small">A limit order buys or sells at your own price and waits. A curve moves its price as it fills.</p>
        <a className="button" href="#/publish">Publish an order</a>
      </Empty>
    );
  }
  return (
    <div className="stack">
      <Filters options={ORDER_FILTERS} counts={counts} value={filter} onChange={setFilter} />
      {error && <Notice kind="error">{error}</Notice>}
      <TransactionState state={tx} />
      {visible.length === 0
        ? <Empty title={`No ${ORDER_STATES[filter as OrderState].label.toLowerCase()} orders`} />
        : <Card>
            <div className="scroll">
              <table>
                <thead><tr><th>Market</th><th>Side</th><th>Type</th><th>Price</th><th>Filled</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {visible.map(curve => {
                    const state = orderState(curve);
                    const partly = state === 'open' && BigInt(curve.filled) > 0n;
                    return (
                      <tr key={curve.orderHash}>
                        <td>
                          <a href={`#/markets/${curve.market}`}>{curve.question}</a>
                          <div className="small muted">{curve.marketStatus === 'OPEN' ? timeLeft(curve.closeAt) : curve.marketStatus.toLowerCase()}</div>
                        </td>
                        <td><span className={`badge ${curve.direction === 'BUY' ? 'resolved' : 'no'}`}>{curve.direction} {curve.side}</span></td>
                        <td className="small">{curve.isLimit ? 'Limit' : `Curve · ${SHAPE_NAMES[curve.shape] ?? ''}`}</td>
                        <td className="small">{curve.isLimit ? priceUsdc(curve.startPrice) : `${priceUsdc(curve.startPrice)} → ${priceUsdc(curve.endPrice)}`}</td>
                        <td className="small">
                          {shares(curve.filled)} / {shares(curve.maxShares)}
                          <Fill filled={curve.filled} total={curve.maxShares} />
                        </td>
                        <td>
                          <span className={`badge ${ORDER_STATES[state].badge}`}>{ORDER_STATES[state].label}</span>
                          {partly && <div className="small muted">partly filled</div>}
                        </td>
                        <td>{curve.cancellable && (
                          <button disabled={busy !== undefined} onClick={() => void cancel(curve)}>
                            {busy === curve.orderHash ? 'Cancelling…' : 'Cancel'}
                          </button>
                        )}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 'var(--space-2)' }}>
              Cancelling withdraws everything an order allocated to Aqua. Terms cannot be edited: publish a new
              order instead. An open order only fills while the wallet behind it still holds the funds, which are
              shared with your other markets.
            </p>
          </Card>}
    </div>
  );
}

/** How far an order has filled, so a part-filled row reads at a glance rather than by arithmetic. */
function Fill({ filled, total }: { filled: string; total: string }) {
  const size = BigInt(total);
  const percent = size === 0n ? 0 : Number((BigInt(filled) * 100n) / size);
  return (
    <div className="fill" title={`${percent}% filled`}>
      <span style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function Filters<T extends string>({ options, counts, value, onChange }: {
  options: [T | 'all', string][]; counts: Record<string, number>; value: T | 'all'; onChange: (next: T | 'all') => void;
}) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return (
    <div className="row">
      {options.map(([option, label]) => (
        <button key={option} className={value === option ? 'primary' : ''} onClick={() => onChange(option)}>
          {label} <span className="count">{option === 'all' ? total : counts[option] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

function tally<T>(rows: T[], state: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[state(row)] = (counts[state(row)] ?? 0) + 1;
  return counts;
}

const SHAPE_NAMES: Record<number, string> = { 1: 'linear', 2: 'quadratic', 3: 'cubic' };
