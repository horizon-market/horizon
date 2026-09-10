import { useState } from 'react';
import { api, ApiError, type AdminActivity, type AdminMarket } from '../api';
import { useAsync } from '../hooks';
import { Address, Card, Empty, ErrorBox, Loading, Logo, Notice, TxLink, describe } from '../components/Ui';
import { dateTime, formatUnits, priceUsdc, shares, usdc } from '../format';

const SHAPES = ['', 'linear', 'quadratic', 'cubic'];

export function Admin() {
  const session = useAsync(() => api.adminSession(), []);
  if (session.loading) return <Loading rows={3} label="Checking admin session" />;
  if (session.error) return <ErrorBox error={session.error} retry={session.reload} />;
  return session.data!.authenticated
    ? <Panel email={session.data!.email ?? ''} onSignOut={() => void api.adminLogout().then(session.reload)} />
    : <SignIn onSignedIn={session.reload} />;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Operator sign in">
      <div className="row" style={{ marginBottom: '.75rem' }}><Logo size={40} /></div>
      <p className="small muted">
        The admin panel inspects creation drafts, payments, published curves, trades, background jobs and market
        resolution. Resolution uses the disclosed centralized resolver; every action is recorded in an audit log.
      </p>
      <form onSubmit={async event => {
        event.preventDefault(); setError(undefined); setBusy(true);
        try { await api.adminLogin(email, password); onSignedIn(); }
        catch (issue) { setError(issue instanceof ApiError ? (issue.status === 401 ? 'Those credentials were not accepted.' : describe(issue.code)) : 'Sign in failed.'); }
        finally { setBusy(false); }
      }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="primary" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Card>
  );
}

type Runner = (action: () => Promise<unknown>, text: string) => Promise<void>;

function Panel({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [market, setMarket] = useState('');
  const overview = useAsync(() => api.adminOverview(), []);
  const activity = useAsync(() => api.adminActivity(market || undefined), [market]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>();
  const run: Runner = async (action, text) => {
    setMessage(undefined);
    try { await action(); setMessage({ kind: 'ok', text }); overview.reload(); activity.reload(); }
    catch (issue) { setMessage({ kind: 'error', text: issue instanceof ApiError ? describe(issue.code) : 'The action failed.' }); }
  };
  if (overview.loading) return <Loading rows={6} label="Loading admin overview" />;
  if (overview.error) return <ErrorBox error={overview.error} retry={overview.reload} />;
  const data = overview.data!;
  const markets = market ? data.markets.filter(entry => entry.market === market) : data.markets;
  return (
    <div className="stack">
      <div className="row between">
        <h1>Admin</h1>
        <div className="row">
          <span className="small muted">{email}</span>
          <button onClick={() => { overview.reload(); activity.reload(); }}>Refresh</button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      {message && <Notice kind={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</Notice>}
      <Card title="Filter">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="market-filter">Market</label>
          <select id="market-filter" value={market} onChange={event => setMarket(event.target.value)}>
            <option value="">All markets ({data.markets.length})</option>
            {data.markets.map(entry => <option key={entry.market} value={entry.market}>{entry.question}</option>)}
          </select>
          <div className="hint">Markets, curves, trades and fills below follow this filter. Indexed at block {activity.data?.indexedBlock ?? '—'}.</div>
        </div>
      </Card>
      <Notice kind="info">
        Resolution is centralized and disclosed. The resolver key is {data.resolverModel.resolver ? <Address value={data.resolverModel.resolver} /> : 'not configured'}.
        Payouts: YES {data.resolverModel.payouts.YES}; NO {data.resolverModel.payouts.NO}; INVALID {data.resolverModel.payouts.INVALID}.
      </Notice>
      {/* Stated on the screen that resolves markets, because this is where the limit matters. */}
      <Notice kind="warn">
        <strong>Group consistency is enforced here only.</strong> {data.resolverModel.groupConsistency.note}
      </Notice>

      {data.events.length > 0 && (
        <Card title={`Events (${data.events.length})`}>
          <p className="small muted" style={{ marginTop: 0 }}>
            Each child below is an independent market with its own collateral. Grouping is Horizon's own metadata; the market
            contracts know nothing about it.
          </p>
          <div className="scroll">
            <table>
              <thead><tr><th>Event</th><th>Rule</th><th>Source</th><th>Markets</th><th>Outcomes</th></tr></thead>
              <tbody>
                {data.events.map(event => (
                  <tr key={event.id}>
                    <td><a href={`/events/${event.slug}`}>{event.title}</a><div className="small muted mono">{event.slug}</div></td>
                    <td className="small">
                      {event.exclusivity === 'EXCLUSIVE' ? 'Exactly one winner' : 'Collection'}
                      <div className="muted">{event.exclusivityEnforcement === 'backend_only' ? 'checked in this workflow only' : 'no rule'}</div>
                    </td>
                    <td className="small">
                      {event.source.provider}
                      {event.source.url && <div className="muted"><a href={event.source.url} target="_blank" rel="noreferrer noopener">source page</a></div>}
                    </td>
                    <td className="small">{event.stats.live} live<div className="muted">{event.stats.resolved} resolved</div></td>
                    <td className="small">{event.outcomesComplete ? 'complete set' : 'partial set'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={`Markets${market ? ' (filtered)' : ''}`}>
        {data.marketsError
          ? <Notice kind="warn">Market data is unavailable ({describe(data.marketsError)}).</Notice>
          : markets.length === 0
            ? <Empty title="No markets are indexed yet" />
            : <div className="stack">{markets.map(entry => <MarketRow key={entry.market} market={entry} run={run} />)}</div>}
      </Card>

      <Activity activity={activity} />

      <Card title="Creation requests">
        <div className="row small muted" style={{ marginBottom: '.5rem' }}>
          {Object.entries(data.counts).map(([status, count]) => <span key={status} className="badge closed">{status}: {count}</span>)}
        </div>
        {data.requests.length === 0 ? <Empty title="No creation requests yet" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Question</th><th>Status</th><th>Client</th><th>Draft</th><th>Price</th><th>Payment</th><th>Market</th><th /></tr></thead>
              <tbody>
                {data.requests.map(request => (
                  <tr key={request.id}>
                    <td>{request.question}<div className="small muted mono">{request.id}</div></td>
                    <td>{request.status}{request.failureCode && <div className="small" style={{ color: 'var(--no)' }}>{request.failureCode}</div>}</td>
                    <td>{request.requesterKind}<div className="small muted">{request.verified ? 'verified human' : 'unverified'}</div></td>
                    <td className="small">{request.draftProvider}<div className="muted">{request.draftMode}</div></td>
                    <td className="small">{formatUnits(request.priceUnits, 8)}{request.discountBps > 0 ? ` (−${request.discountBps / 100}%)` : ''}</td>
                    <td className="small">{request.paymentStatus ?? '—'}</td>
                    <td className="small">{request.marketAddress ? <Address value={request.marketAddress} /> : '—'}{request.creationTxHash && <div><TxLink hash={request.creationTxHash} /></div>}</td>
                    <td>{['PAID', 'FAILED'].includes(request.status) && (
                      <button onClick={() => void run(() => api.adminRetry(request.id), 'Creation job re-enqueued. A settled payment is never charged again.')}>Retry</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Payments">
        {data.payments.length === 0 ? <Empty title="No payment intents yet" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Created</th><th>Status</th><th>Amount</th><th>Facilitator</th><th>Reference</th><th>Attempts</th><th /></tr></thead>
              <tbody>
                {data.payments.map(payment => (
                  <tr key={payment.id}>
                    <td className="small">{dateTime(payment.createdAt)}</td>
                    <td>{payment.status}{payment.failureCode && <div className="small muted">{payment.failureCode}</div>}</td>
                    <td className="small">{formatUnits(payment.amountUnits, 8)} {payment.asset}</td>
                    <td className="small">{payment.facilitator}</td>
                    <td className="small mono">{payment.transactionRef ?? '—'}</td>
                    <td>{payment.attempts}</td>
                    <td>{['REVIEW', 'SUBMITTED'].includes(payment.status) && <Reconcile id={payment.id} run={run} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Resolutions">
        {data.resolutions.length === 0 ? <Empty title="No resolutions have been requested" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Market</th><th>Result</th><th>Status</th><th>Transaction</th><th>Attempts</th></tr></thead>
              <tbody>
                {data.resolutions.map(resolution => (
                  <tr key={resolution.id}>
                    <td className="small"><Address value={resolution.market} /></td>
                    <td>{resolution.result}</td>
                    <td>{resolution.status}{resolution.failureCode && <div className="small muted">{resolution.failureCode}</div>}</td>
                    <td className="small">{resolution.txHash ? <TxLink hash={resolution.txHash} /> : '—'}</td>
                    <td>{resolution.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Background jobs">
        {data.jobs.length === 0 ? <Empty title="No job runs recorded" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Business id</th><th>Latest outcome</th><th>Recorded</th></tr></thead>
              <tbody>{data.jobs.map(job => (
                <tr key={job.id}><td className="small mono">{job.id}</td><td>{job.label}</td><td className="small">{dateTime(job.completedAt)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Activity({ activity }: { activity: ReturnType<typeof useAsync<AdminActivity>> }) {
  if (activity.loading) return <Card title="Curves, trades and fills"><Loading rows={4} label="Loading indexed activity" /></Card>;
  if (activity.error) return <Card title="Curves, trades and fills"><ErrorBox error={activity.error} retry={activity.reload} /></Card>;
  const data = activity.data!;
  return (
    <>
      <Card title={`Published curves (${data.curves.length})`}>
        <p className="small muted">
          Every indexed curve, including cancelled and exhausted ones. A curve is one Aqua order: publishing it is the
          explicit step that offers liquidity, and changing terms requires a new order.
        </p>
        {data.curves.length === 0 ? <Empty title="No curves indexed for this filter" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Maker</th><th>Order</th><th>Prices</th><th>Shape</th><th>Filled</th><th>Remaining</th><th>State</th><th>Market</th></tr></thead>
              <tbody>
                {data.curves.map(curve => (
                  <tr key={curve.id}>
                    <td className="small"><Address value={curve.maker} /></td>
                    <td><span className={`badge ${curve.side === 'YES' ? 'resolved' : 'no'}`}>{curve.direction} {curve.side}</span>
                      <div className="small muted mono">{curve.id.slice(0, 12)}…</div></td>
                    <td className="small">{priceUsdc(curve.startPrice)} → {priceUsdc(curve.endPrice)}</td>
                    <td className="small">{SHAPES[curve.shape]}</td>
                    <td className="small">{shares(curve.filled)} / {shares(curve.maxShares)}</td>
                    <td className="small">{shares(curve.remaining)}</td>
                    <td>
                      {/* Shipped to Aqua is not the same as executable: an order the router never
                          admitted holds its maker's allocation but can never fill. */}
                      <span className={`badge ${curve.active && curve.admitted ? 'open' : curve.active ? 'warn' : 'closed'}`}>
                        {curve.active ? (curve.admitted ? 'active' : 'not published') : 'inactive'}
                      </span>
                    </td>
                    <td className="small">{curve.question}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Trades (${data.routes.length})`}>
        <p className="small muted">
          One route is one atomic taker transaction of at most four fills. Fees charged: maker {data.fees.maker}%,
          taker {data.fees.taker}%, routing {data.fees.routing}%, protocol {data.fees.protocol}%.
        </p>
        {data.routes.length === 0 ? <Empty title="No trades indexed for this filter" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Block</th><th>Taker</th><th>Side</th><th>Shares</th><th>USDC</th><th>Fills</th><th>Transaction</th><th>Market</th></tr></thead>
              <tbody>
                {data.routes.map(route => (
                  <tr key={route.id}>
                    <td className="small">{route.block}</td>
                    <td className="small"><Address value={route.taker} />
                      {route.recipient.toLowerCase() !== route.taker.toLowerCase() && <div className="small muted">to <Address value={route.recipient} /></div>}</td>
                    <td><span className={`badge ${route.isYes ? 'resolved' : 'no'}`}>{route.isBuy ? 'BUY' : 'SELL'} {route.isYes ? 'YES' : 'NO'}</span></td>
                    <td className="small">{shares(route.shares)}</td>
                    <td className="small">{usdc(route.usdc)}</td>
                    <td>{route.fills}</td>
                    <td className="small"><TxLink hash={route.transaction} /></td>
                    <td className="small">{route.question}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Fills against curves (${data.fills.length})`}>
        {data.fills.length === 0 ? <Empty title="No fills indexed for this filter" /> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Block</th><th>Maker</th><th>Curve</th><th>Shares</th><th>Maker USDC</th><th>Transaction</th><th>Market</th></tr></thead>
              <tbody>
                {data.fills.map(fill => (
                  <tr key={fill.id}>
                    <td className="small">{fill.block}</td>
                    <td className="small"><Address value={fill.maker} /></td>
                    <td><span className={`badge ${fill.side === 'YES' ? 'resolved' : 'no'}`}>{fill.direction} {fill.side}</span>
                      <div className="small muted mono">{fill.strategy.slice(0, 12)}…</div></td>
                    <td className="small">{shares(fill.shares)}</td>
                    <td className="small">{usdc(fill.usdc)}</td>
                    <td className="small"><TxLink hash={fill.transaction} /></td>
                    <td className="small">{fill.question}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function MarketRow({ market, run }: { market: AdminMarket; run: Runner }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState('YES');
  const [evidence, setEvidence] = useState('');
  const resolved = market.result !== 'UNRESOLVED';
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row between">
        <span className={`badge ${market.status === 'OPEN' ? 'open' : resolved ? 'resolved' : 'warn'}`}>
          {resolved ? `Resolved ${market.result}` : market.status}
        </span>
        <span className="small muted">Closes {dateTime(market.closeAt)}</span>
      </div>
      <h3 style={{ marginTop: '.5rem' }}>{market.question}</h3>
      <dl className="kv">
        <dt>Market</dt><dd><Address value={market.market} /></dd>
        <dt>Collateral</dt><dd>{usdc(market.collateral)} · {market.curves} live curve{market.curves === 1 ? '' : 's'}</dd>
        <dt>Rules</dt><dd className="small">{market.rules}</dd>
        <dt>Evidence source</dt><dd className="small">{market.evidenceSource}</dd>
        {resolved && <><dt>Resolution evidence</dt><dd className="small">{market.resolutionEvidence}</dd></>}
      </dl>
      {resolved
        ? <Notice kind="ok">This market is resolved. A market accepts exactly one result and it cannot be changed.</Notice>
        : market.resolvable
          ? <div className="stack" style={{ marginTop: '.5rem' }}>
              {!open
                ? <div><button className="primary" onClick={() => setOpen(true)}>Resolve market</button></div>
                : <>
                    <div className="fields">
                      <div className="field">
                        <label>Result</label>
                        <select value={result} onChange={event => setResult(event.target.value)}>
                          <option value="YES">YES — 1 USDC per YES token</option>
                          <option value="NO">NO — 1 USDC per NO token</option>
                          <option value="INVALID">INVALID — 0.5 USDC per outcome token</option>
                        </select>
                      </div>
                      <div className="field">
                        <label>Evidence reference</label>
                        <input value={evidence} onChange={event => setEvidence(event.target.value)} placeholder="Public URL or citation used to decide" />
                        <div className="hint">At least 10 characters. It is published on chain with the result.</div>
                      </div>
                    </div>
                    <div className="row">
                      <button className="primary" disabled={evidence.trim().length < 10} onClick={() => void run(
                        () => api.adminResolve(market.market, result, evidence.trim()),
                        'Resolution queued for the disclosed resolver key. It is submitted once and the on-chain result is re-checked before every attempt.',
                      )}>Queue {result} resolution</button>
                      <button onClick={() => setOpen(false)}>Cancel</button>
                    </div>
                  </>}
            </div>
          : <Notice kind="warn">
              Resolvable after {dateTime(market.closeAt)}. The market contract refuses a result before its close time,
              so the action stays disabled until then.
            </Notice>}
    </div>
  );
}

function Reconcile({ id, run }: { id: string; run: Runner }) {
  const [reference, setReference] = useState('');
  const [outcome, setOutcome] = useState<'SETTLED' | 'FAILED'>('SETTLED');
  return (
    <div className="stack" style={{ minWidth: '14rem' }}>
      <input value={reference} onChange={event => setReference(event.target.value)} placeholder="Ledger or facilitator reference" />
      <select value={outcome} onChange={event => setOutcome(event.target.value as 'SETTLED' | 'FAILED')}>
        <option value="SETTLED">Confirmed settled</option>
        <option value="FAILED">Confirmed not settled</option>
      </select>
      <button disabled={reference.trim().length < 3} onClick={() => void run(() => api.adminReconcile(id, outcome, reference.trim()), 'Payment reconciled from the recorded evidence.')}>
        Record reconciliation
      </button>
    </div>
  );
}
