import { useState } from 'react';
import { api, ApiError, type AdminOverview } from '../api';
import { useAsync } from '../hooks';
import { Address, Card, Empty, ErrorBox, Loading, Notice, TxLink, describe } from '../components/Ui';
import { dateTime, formatUnits, usdc } from '../format';

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
      <p className="small muted">
        The admin panel inspects creation drafts, payments, background jobs and markets awaiting resolution.
        Resolution uses the disclosed centralized resolver; every action is recorded in an audit log.
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

function Panel({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const overview = useAsync(() => api.adminOverview(), []);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>();
  const run = async (action: () => Promise<unknown>, text: string) => {
    setMessage(undefined);
    try { await action(); setMessage({ kind: 'ok', text }); overview.reload(); }
    catch (issue) { setMessage({ kind: 'error', text: issue instanceof ApiError ? describe(issue.code) : 'The action failed.' }); }
  };
  if (overview.loading) return <Loading rows={6} label="Loading admin overview" />;
  if (overview.error) return <ErrorBox error={overview.error} retry={overview.reload} />;
  const data = overview.data!;
  return (
    <div className="stack">
      <div className="row between">
        <h1>Admin</h1>
        <div className="row">
          <span className="small muted">{email}</span>
          <button onClick={overview.reload}>Refresh</button>
          <button onClick={onSignOut}>Sign out</button>
        </div>
      </div>
      {message && <Notice kind={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</Notice>}
      <Notice kind="info">
        Resolution is centralized and disclosed. The resolver key is {data.resolverModel.resolver ? <Address value={data.resolverModel.resolver} /> : 'not configured'}.
        Payouts: YES {data.resolverModel.payouts.YES}; NO {data.resolverModel.payouts.NO}; INVALID {data.resolverModel.payouts.INVALID}.
      </Notice>
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
      <Card title="Markets awaiting resolution">
        {data.marketsError
          ? <Notice kind="warn">Market data is unavailable ({describe(data.marketsError)}).</Notice>
          : data.awaitingResolution.length === 0
            ? <Empty title="No closed markets are waiting for a result" />
            : <div className="stack">{data.awaitingResolution.map(market => <Resolve key={market.market} market={market} run={run} />)}</div>}
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

function Reconcile({ id, run }: { id: string; run: (action: () => Promise<unknown>, text: string) => Promise<void> }) {
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

function Resolve({ market, run }: { market: AdminOverview['awaitingResolution'][number]; run: (action: () => Promise<unknown>, text: string) => Promise<void> }) {
  const [result, setResult] = useState('YES');
  const [evidence, setEvidence] = useState('');
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <h3>{market.question}</h3>
      <dl className="kv">
        <dt>Market</dt><dd><Address value={market.market} /></dd>
        <dt>Closed</dt><dd>{dateTime(market.closeAt)}</dd>
        <dt>Collateral</dt><dd>{usdc(market.collateral)}</dd>
        <dt>Rules</dt><dd className="small">{market.rules}</dd>
        <dt>Evidence source</dt><dd className="small">{market.evidenceSource}</dd>
      </dl>
      <div className="fields" style={{ marginTop: '.5rem' }}>
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
        </div>
      </div>
      <button className="primary" disabled={evidence.trim().length < 10} onClick={() => void run(
        () => api.adminResolve(market.market, result, evidence.trim()),
        'Resolution queued for the disclosed resolver key. It is submitted once and re-checked on chain before every attempt.',
      )}>Queue resolution</button>
    </div>
  );
}
