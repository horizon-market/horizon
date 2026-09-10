import { useState } from 'react';
import { api, ApiError, type CreationSummary, type HorizonEvent, type MakerCurve, type Position } from '../api';
import { navigate, useAsync, type Async } from '../hooks';
import { useWallet } from '../App';
import { Badge, Card, Empty, ErrorBox, Fill, HelpLink, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { CREATION_BADGE, CREATION_LABEL, activateCreation, creationToken, isFinished } from '../creations';
import { ORDER_STATES, orderState, useCancelCurve, type OrderState } from '../orders';
import { cumulative, type CurveShape } from '../curve';
import { dateTime, formatUnits, priceUsdc, shares, timeLeft, usdc } from '../format';
import { confirm, describeWalletError, send } from '../wallet';

/** Which event a market belongs to, so a position or a request reads with its group context. */
type EventIndex = Map<string, { slug: string; title: string; outcomeLabel: string }>;
const indexEvents = (events: HorizonEvent[]): EventIndex => new Map(events.flatMap(event =>
  event.children.filter(child => child.marketAddress).map(child =>
    [child.marketAddress!.toLowerCase(), { slug: event.slug, title: event.title, outcomeLabel: child.outcomeLabel }] as const)));

function EventLabel({ context }: { context: { slug: string; title: string; outcomeLabel: string } | undefined }) {
  if (!context) return null;
  return (
    <div className="small muted">
      {context.outcomeLabel} · <a href={`/events/${context.slug}`}>{context.title}</a>
    </div>
  );
}

/**
 * Two things live here and they have different lifecycles: outcome tokens this account holds,
 * and orders it has published. Each is a tab, and each row states which stage of its life it is
 * in, because what you can do with it — trade, wait, redeem, cancel — follows from that stage.
 */

type PositionState = 'open' | 'awaiting' | 'redeemable' | 'settled';

const POSITION_STATES: Record<PositionState, { label: string; badge: 'open' | 'warn' | 'resolved' | 'closed'; hint: string }> = {
  open: { label: 'Open', badge: 'open', hint: 'Trading is still open in this market.' },
  awaiting: { label: 'Awaiting result', badge: 'warn', hint: 'Trading has closed. The disclosed resolver has not submitted a result yet.' },
  redeemable: { label: 'Redeemable', badge: 'resolved', hint: 'Resolved in your favour. Redeem to burn the tokens and take the collateral.' },
  settled: { label: 'No payout', badge: 'closed', hint: 'Resolved against this holding, so it pays nothing.' },
};

const POSITION_FILTERS: [PositionState | 'all', string][] = [
  ['all', 'All'], ['open', 'Open'], ['awaiting', 'Awaiting result'], ['redeemable', 'Redeemable'], ['settled', 'No payout'],
];
const ORDER_FILTERS: [OrderState | 'all', string][] = [
  ['open', 'Open'], ['unpublished', 'Not published'], ['filled', 'Filled'], ['closed', 'Closed'], ['all', 'All'],
];

// Redeemable first, then whatever still needs watching, then the finished rows.
const POSITION_ORDER: PositionState[] = ['redeemable', 'open', 'awaiting', 'settled'];
// An unpublished order holds funds without resting, so it sits with the open ones and not in history.
const ORDER_ORDER: OrderState[] = ['unpublished', 'open', 'filled', 'closed'];

function positionState(position: Position): PositionState {
  if (position.status === 'OPEN') return 'open';
  if (position.status !== 'RESOLVED') return 'awaiting';
  return BigInt(position.redeemableUsdc) > 0n ? 'redeemable' : 'settled';
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
  const raw = query.get('tab');
  const tab = raw === 'orders' ? 'orders' : raw === 'requests' ? 'requests' : 'positions';
  const positions = useAsync(async () => account ? api.positions(account) : { indexedBlock: 0, positions: [] as Position[] }, [account]);
  const orders = useAsync(async () => account ? api.makerCurves(account) : { indexedBlock: 0, curves: [] as MakerCurve[] }, [account]);
  // Group context for both tabs. It is decoration, so a failure here must not fail the page.
  const events = useAsync(async () => indexEvents((await api.events().catch(() => ({ events: [] as HorizonEvent[] }))).events), []);
  const requests = useAsync(async () => account ? (await api.myCreations(account)).requests : [] as CreationSummary[], [account]);

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
  const grouped = events.data ?? new Map();
  const myRequests = requests.data ?? [];
  const resumable = myRequests.filter(entry => !isFinished(entry.status) && creationToken(entry.id));

  return (
    <div className="stack">
      <div className="row between">
        <h1>Portfolio</h1>
        <button onClick={() => { positions.reload(); orders.reload(); }}>Refresh</button>
      </div>

      <Summary held={held} published={published} />

      {resumable.length > 0 && tab !== 'requests' && (
        <Notice kind="info">
          You have {resumable.length} market request{resumable.length === 1 ? '' : 's'} still in progress.{' '}
          <a href="/holdings?tab=requests">Pick {resumable.length === 1 ? 'it' : 'one'} up</a>.
        </Notice>
      )}

      <div className="seg tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'positions'} className={tab === 'positions' ? 'active' : ''}
          onClick={() => navigate('/holdings')}>
          Positions <span className="count">{held.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''}
          onClick={() => navigate('/holdings?tab=orders')}>
          Orders <span className="count">{openOrders.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'active' : ''}
          onClick={() => navigate('/holdings?tab=requests')}>
          Market requests <span className="count">{myRequests.length}</span>
        </button>
      </div>

      {tab === 'positions' && <Positions held={held} account={account} events={grouped} onDone={() => { positions.reload(); orders.reload(); }} />}
      {tab === 'orders' && <Orders published={published} account={account} events={grouped} onDone={orders.reload} />}
      {tab === 'requests' && <Requests state={requests} />}
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

function Positions({ held, account, events, onDone }: { held: Position[]; account: string; events: EventIndex; onDone: () => void }) {
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
        <a className="button" href="/">Browse markets</a>
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
                          <a href={`/markets/${position.market}`}>{position.question}</a>
                          <EventLabel context={events.get(position.market.toLowerCase())} />
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
                            : <a className="button" href={`/markets/${position.market}`}>{state === 'open' ? 'Trade' : 'View'}</a>}
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

function Orders({ published, account, events, onDone }: { published: MakerCurve[]; account: string; events: EventIndex; onDone: () => void }) {
  const [filter, setFilter] = useState<OrderState | 'all'>('open');
  const { cancel, busy, tx, error } = useCancelCurve(account, onDone);
  const counts = tally(published, orderState);
  const visible = published
    .filter(curve => filter === 'all' || orderState(curve) === filter)
    .sort((a, b) => ORDER_ORDER.indexOf(orderState(a)) - ORDER_ORDER.indexOf(orderState(b)) || b.publishedAt - a.publishedAt);

  if (published.length === 0) {
    return (
      <Empty title="No orders yet">
        <p className="small">
          A limit order buys or sells at your own price and waits; a curve moves its price as it fills. Both are
          published from a market's trade ticket.
        </p>
        {/* Nothing to read here yet, so the two things worth doing next stand side by side: go find a
            market, or learn what the second order type is before publishing one. */}
        <div className="row" style={{ justifyContent: 'center', gap: 'var(--space-4)' }}>
          <a className="button" href="/">Browse markets</a>
          <HelpLink href="/curves">How curves work</HelpLink>
        </div>
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
                          <a href={`/markets/${curve.market}`}>{curve.question}</a>
                          <EventLabel context={events.get(curve.market.toLowerCase())} />
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
                          {state === 'unpublished' && (
                            <div className="small muted">Funds are allocated in Aqua but Horizon never accepted this order, so it cannot fill. Cancel it to take the allocation back.</div>
                          )}
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

/**
 * Every market request this account has made. A request whose access token is still in this
 * browser can be picked up again — that token is the only way to move it along, and the server
 * keeps a hash of it, so a request opened in another browser is history here rather than work.
 */
function Requests({ state }: { state: Async<CreationSummary[]> }) {
  if (state.loading) return <Loading rows={4} label="Loading market requests" />;
  if (state.error) return <ErrorBox error={state.error} retry={state.reload} />;
  const requests = state.data ?? [];
  if (requests.length === 0) {
    return (
      <Empty title="No market requests yet">
        <p className="small">Create a single market, a group of markets, or import an event definition.</p>
        <a className="button" href="/create">Create a market</a>
      </Empty>
    );
  }
  return (
    <Card>
      <div className="scroll">
        <table>
          <thead><tr><th>Request</th><th>Kind</th><th>Status</th><th>Price</th><th /></tr></thead>
          <tbody>
            {requests.map(request => {
              const token = creationToken(request.id);
              const group = request.kind === 'GROUP';
              return (
                <tr key={request.id}>
                  <td>
                    <strong>{request.event?.title ?? request.question}</strong>
                    {request.event && (
                      <div className="small muted">
                        {request.event.sourceProvider === 'horizon' ? 'Event created on Horizon' : `Imported from ${request.event.sourceProvider}`}
                        {request.event.exclusivity === 'EXCLUSIVE' && ' · exactly one winner'}
                        {request.childrenCreated > 0 && <> · <a href={`/events/${request.event.slug}`}>view event</a></>}
                      </div>
                    )}
                    <div className="small muted">{dateTime(request.createdAt)}</div>
                  </td>
                  <td className="small">
                    {group ? <>{request.children} market{request.children === 1 ? '' : 's'}<div className="muted">{request.childrenCreated} created</div></> : 'One market'}
                  </td>
                  <td>
                    <Badge kind={CREATION_BADGE[request.status] ?? 'closed'}>{CREATION_LABEL[request.status] ?? request.status}</Badge>
                    {request.failureCode && <div className="small muted">{describe(request.failureCode)}</div>}
                  </td>
                  <td className="small">
                    {request.paymentStatus
                      ? <>{formatUnits(request.priceUnits, 8)} {request.asset === '0.0.0' ? 'HBAR' : request.asset ?? ''}
                          <div className="muted">{request.paymentStatus.toLowerCase()}</div></>
                      : <span className="muted">not priced yet</span>}
                  </td>
                  <td>
                    {request.marketAddress
                      ? <a className="button" href={`/markets/${request.marketAddress}`}>Open market</a>
                      : !isFinished(request.status) && token
                        ? <button className="primary" onClick={() => { activateCreation({ id: request.id, token }); navigate('/create'); }}>Resume</button>
                        : request.event && request.childrenCreated > 0
                          ? <a className="button" href={`/events/${request.event.slug}`}>Open event</a>
                          : <span className="muted small">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginTop: 'var(--space-2)' }}>
        A request can only be resumed from the browser that created it: its access token lives here and nowhere else,
        and the server stores only a hash of it. A paid request that failed part way stays recoverable and is never charged twice.
      </p>
    </Card>
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

// The names the trade ticket publishes under, so an order does not change vocabulary between the
// screen that made it and the screen that lists it.
const SHAPE_NAMES: Record<number, string> = { 1: 'Even', 2: 'Patient', 3: 'Very patient' };
