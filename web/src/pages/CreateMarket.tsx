import { lazy, Suspense, useState } from 'react';
import type { RpContext } from '@worldcoin/idkit';
import { api, ApiError, type CreationRequest, type PaymentRequirements, type PaymentResource } from '../api';
import { useLocalState } from '../hooks';
import { CREATION_LABEL, forgetCreation, isDiscardable, rememberCreation, type Saved } from '../creations';
import { useConfig, useWallet } from '../App';
import { Card, Notice, TxLink, describe } from '../components/Ui';
import { dateTime, formatUnits } from '../format';

const WorldVerification = lazy(() => import('../components/WorldVerification').then(module => ({ default: module.WorldVerification })));

const STEPS = ['Describe', 'Review draft', 'Verify (optional)', 'Pay', 'Market'] as const;

const stepFor = (request: CreationRequest | undefined) => {
  if (!request) return 0;
  if (request.status === 'DRAFT') return 1;
  if (request.status === 'APPROVED') return 2;
  if (['PAYMENT_REQUIRED', 'PAYMENT_REVIEW'].includes(request.status)) return 3;
  return 4;
};

export function CreateMarket() {
  const config = useConfig();
  const wallet = useWallet();
  const [saved, setSaved] = useLocalState<Saved | null>('horizon.creation', null);
  const [request, setRequest] = useState<CreationRequest | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const release = () => { setSaved(null); setRequest(undefined); setLoaded(false); setError(undefined); };

  if (saved && !loaded) {
    setLoaded(true);
    api.getRequest(saved.id, saved.token).then(
      // A request discarded from another tab, or on a previous visit, never blocks the form again.
      result => result.request.status === 'ABANDONED' ? release() : setRequest(result.request),
      () => release(),
    );
  }

  const act = async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined); setBusy(true);
    try { return await run(); }
    catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : issue instanceof Error ? issue.message : 'The request failed.'); return undefined; }
    finally { setBusy(false); }
  };

  const step = stepFor(request);
  return (
    <div className="stack">
      <h1>Create a market</h1>
      <div className="steps">
        {STEPS.map((label, index) => <span key={label} className={index < step ? 'done' : index === step ? 'active' : ''}>{index + 1}. {label}</span>)}
      </div>
      <Notice kind="info">
        Market creation is a paid service on Hedera through x402. It is <strong>separate from trading, which has no fee at all</strong>.
        Standard price {formatUnits(config.creation.priceUnits, config.creation.assetDecimals)} {config.creation.asset}
        {config.creation.discountBps > 0 && <> · verified humans pay {formatUnits((BigInt(config.creation.priceUnits) * BigInt(10_000 - config.creation.discountBps) / 10_000n).toString(), config.creation.assetDecimals)} {config.creation.asset}</>}.
      </Notice>
      {config.creation.settlementMode === 'simulated' && (
        <Notice kind="warn">
          This API runs the creation payment in <strong>simulated</strong> settlement mode. No Hedera transaction is performed and every
          record is stored and shown as simulated.
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {!request && <Describe busy={busy} account={wallet.account} onCreate={async input => {
        const result = await act(() => api.createDraft(input, crypto.randomUUID()));
        if (result?.accessToken) {
          const key = { id: result.request.id, token: result.accessToken };
          rememberCreation(key); setSaved(key); setRequest(result.request);
        }
        else if (result) setError('That draft already exists but its access token is not available in this browser.');
      }} />}
      {request && saved && (
        <div className="stack">
          <Review request={request} />
          {request.status === 'DRAFT' && (
            <Card title="Approve the exact draft">
              <p className="small muted">
                Nothing is charged and no market is created until you approve this exact text. Approval is bound to the draft's hash,
                so a changed draft must be reviewed again.
              </p>
              <button className="primary" disabled={busy} onClick={async () => {
                const result = await act(() => api.approve(saved.id, saved.token, request.draftHash!));
                if (result) setRequest(result.request);
              }}>Approve and continue</button>
            </Card>
          )}
          {request.status === 'APPROVED' && <Verification request={request} busy={busy} onVerified={setRequest} onSkip={async () => {
            const result = await act(() => api.requirePayment(saved.id, saved.token));
            if (result) setRequest(result.request);
          }} act={act} saved={saved} />}
          {['PAYMENT_REQUIRED', 'PAYMENT_REVIEW'].includes(request.status) && <Payment request={request} saved={saved} busy={busy} act={act} onPaid={setRequest} />}
          {['PAID', 'CREATING', 'CREATED', 'FAILED'].includes(request.status) && (
            <Outcome request={request} busy={busy} onRefresh={async () => {
              const result = await act(() => api.getRequest(saved.id, saved.token));
              if (result) setRequest(result.request);
            }} onReset={release} />
          )}
          <StartOver request={request} busy={busy} onRelease={release}
            onDiscard={async () => {
              const result = await act(() => api.abandon(saved.id, saved.token));
              if (result) { forgetCreation(saved.id); release(); }
            }} />
        </div>
      )}
    </div>
  );
}

/**
 * The way out of a request the requester no longer wants. Before any money moves it is discarded
 * outright, on the server as well as here, so the request cannot be resumed by accident and the
 * payment intent behind it is cancelled. Once a payment has settled or is settling there is nothing
 * to discard: the request is simply set aside, and its access token stays in this browser so the
 * portfolio can still reach it.
 */
function StartOver({ request, busy, onDiscard, onRelease }: {
  request: CreationRequest; busy: boolean; onDiscard: () => Promise<void>; onRelease: () => void;
}) {
  const discardable = isDiscardable(request.status, request.payment?.status);
  if (request.status === 'CREATED') return null;
  return (
    <Card title="Start a different market">
      <p className="small muted" style={{ marginBottom: 'var(--space-3)' }}>
        {discardable
          ? `This request is at “${CREATION_LABEL[request.status] ?? request.status}” and nothing has been charged for it.
             Discarding it cancels its payment request and frees you to draft another.`
          : `A payment for this request has settled or is settling, so it cannot be discarded. Setting it aside starts a
             fresh request; this one keeps its place in your portfolio, where you can pick it up again.`}
      </p>
      {discardable
        ? <button disabled={busy} onClick={() => void onDiscard()}>{busy ? 'Discarding…' : 'Discard this request'}</button>
        : <button disabled={busy} onClick={onRelease}>Set aside and start another</button>}
    </Card>
  );
}

function Describe({ busy, account, onCreate }: { busy: boolean; account?: string; onCreate: (input: { question: string; requesterKind: 'browser' | 'agent'; requester: string; category?: string; closeAt?: string }) => Promise<void> }) {
  const config = useConfig();
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('');
  const [closeAt, setCloseAt] = useState('');
  const tooShort = question.trim().length < 15;
  return (
    <Card title="Describe the question">
      <p className="small muted">
        The drafting provider is <strong>{config.ai.provider}</strong> ({config.ai.mode === 'live' ? 'live model' : 'deterministic development provider'}).
        It reads the live indexed market set to propose outcomes, a close time, a category, resolution rules, an evidence source and duplicate warnings.
        You review everything before paying.
      </p>
      <div className="field">
        <label htmlFor="question">Binary question</label>
        <textarea id="question" value={question} maxLength={200} onChange={event => setQuestion(event.target.value)}
          placeholder="Will …happen before …?" />
        {tooShort ? <div className="hint">Write at least 15 characters; a clear, checkable question resolves better.</div>
          : <div className="hint">{200 - question.length} characters left.</div>}
      </div>
      <div className="fields">
        <div className="field">
          <label htmlFor="category">Category (optional)</label>
          <input id="category" value={category} maxLength={40} onChange={event => setCategory(event.target.value)} placeholder="Crypto, Sports, Politics…" />
        </div>
        <div className="field">
          <label htmlFor="close">Preferred close time (optional)</label>
          <input id="close" type="datetime-local" value={closeAt} onChange={event => setCloseAt(event.target.value)} />
          <div className="hint">Trading stops at this time; the resolver acts afterwards.</div>
        </div>
      </div>
      <button className="primary" disabled={busy || tooShort} onClick={() => void onCreate({
        question: question.trim(), requesterKind: 'browser', requester: account ?? 'browser',
        category: category.trim() || undefined, closeAt: closeAt ? new Date(closeAt).toISOString() : undefined,
      })}>{busy ? 'Drafting…' : 'Draft this market'}</button>
    </Card>
  );
}

function Review({ request }: { request: CreationRequest }) {
  const draft = request.draft;
  const warnings = request.review?.warnings ?? [];
  return (
    <Card title="Proposed market" actions={<span className="badge closed">{request.status}</span>}>
      {!draft ? <p className="muted">No draft is attached to this request.</p> : (
        <>
          <dl className="kv">
            <dt>Question</dt><dd><strong>{draft.question}</strong></dd>
            <dt>Outcomes</dt><dd>{draft.yesOutcome} / {draft.noOutcome}</dd>
            <dt>Category</dt><dd>{draft.category}</dd>
            <dt>Trading closes</dt><dd>{dateTime(draft.closeAt)}</dd>
            <dt>Resolution rules</dt><dd>{draft.rules}</dd>
            <dt>Evidence source</dt><dd>{draft.evidenceSource}</dd>
            <dt>Drafted by</dt><dd>{request.draftProvider} ({request.draftMode})</dd>
          </dl>
          <p className="small muted" style={{ marginTop: '.6rem' }}>{request.review?.rationale}</p>
          {request.review?.duplicateCheck === 'live_graph'
            ? <p className="small muted">Duplicate check ran against live indexed markets at block {request.review.groundedOnBlock}.</p>
            : <Notice kind="warn">No indexed market source is configured, so no duplicate check was performed.</Notice>}
          {warnings.length > 0 && (
            <Notice kind="warn">
              <strong>{warnings.length} possible duplicate{warnings.length === 1 ? '' : 's'}.</strong> Trading an existing market is free; creating a new one is not.
              <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
                {warnings.map(warning => (
                  <li key={warning.market}>
                    <a href={`#/markets/${warning.market}`}>{warning.question}</a> — {Math.round(warning.similarity * 100)}% overlap. {warning.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
        </>
      )}
    </Card>
  );
}

type Act = <T,>(run: () => Promise<T>) => Promise<T | undefined>;

function Verification({ request, saved, busy, act, onVerified, onSkip }: {
  request: CreationRequest; saved: { id: string; token: string }; busy: boolean; act: Act;
  onVerified: (request: CreationRequest) => void; onSkip: () => Promise<void>;
}) {
  const config = useConfig();
  const [proof, setProof] = useState('');
  const [rpContext, setRpContext] = useState<RpContext | undefined>();
  const [worldOpen, setWorldOpen] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  return (
    <Card title="Human verification (optional)">
      <p className="small muted">
        A World credential verified on the server lowers the creation price by {config.creation.discountBps / 100}%, once per credential per UTC day.
        Only the credential's nullifier hash and type are stored. Verification is an abuse-resistance signal, not proof of forecasting skill.
      </p>
      {request.verification && <Notice kind="ok">Verified {request.verification.credentialType} credential recorded at {dateTime(request.verification.verifiedAt)}.</Notice>}
      {verificationError && <Notice kind="error">{verificationError}</Notice>}
      {!config.world.available
        ? <Notice kind="warn">
            World Selfie Check is unavailable on this deployment (access: {config.world.access}). {config.world.reason} The standard price applies.
          </Notice>
        : config.world.widgetAvailable ? <div className="stack">
            <button className="primary" disabled={busy} onClick={() => void act(() => api.worldContext(saved.id, saved.token)).then(context => {
              if (context) { setVerificationError(null); setRpContext(context); setWorldOpen(true); }
            })}>Verify with World</button>
            {rpContext && <Suspense fallback={<p className="small muted">Loading World verification…</p>}>
              <WorldVerification open={worldOpen} onOpenChange={setWorldOpen} appId={config.world.appId}
                action={config.world.action} environment={config.world.environment} requestId={request.id} rpContext={rpContext}
                onVerify={async result => {
                  try {
                    const updated = await api.verify(saved.id, saved.token, result);
                    setVerificationError(null);
                    onVerified(updated.request);
                  } catch (error) {
                    setVerificationError(error instanceof ApiError ? describe(error.code) : 'Could not reach Horizon to verify the proof. Please try again.');
                    // IDKit must still show failure when our backend does not verify the proof.
                    throw error;
                  }
                }} />
            </Suspense>}
          </div>
        : <div className="field">
            <label htmlFor="proof">Complete IDKit result JSON from the World Selfie Check flow</label>
            <textarea id="proof" value={proof} onChange={event => setProof(event.target.value)}
              placeholder='{"protocol_version":"3.0","nonce":"…","action":"…","environment":"staging","responses":[{"identifier":"selfie","signal_hash":"0x…","proof":"0x…","merkle_root":"0x…","nullifier":"0x…"}],"user_presence_completed":true}' />
            <div className="hint">The server verifies this proof with World before any discount is applied.</div>
          </div>}
      <div className="row">
        {config.world.available && !config.world.widgetAvailable && (
          <button className="primary" disabled={busy || proof.trim().length < 16} onClick={async () => {
            let parsed: unknown;
            try { parsed = JSON.parse(proof); } catch { return; }
            const result = await act(() => api.verify(saved.id, saved.token, parsed));
            if (result) onVerified(result.request);
          }}>Verify credential</button>
        )}
        <button className={config.world.available ? '' : 'primary'} disabled={busy} onClick={() => void onSkip()}>
          {request.verification ? 'Continue to payment' : 'Continue without verification'}
        </button>
      </div>
    </Card>
  );
}

function Payment({ request, saved, busy, act, onPaid }: { request: CreationRequest; saved: { id: string; token: string }; busy: boolean; act: Act; onPaid: (request: CreationRequest) => void }) {
  const config = useConfig();
  const [requirements, setRequirements] = useState<PaymentRequirements | undefined>();
  const [resource, setResource] = useState<PaymentResource | undefined>();
  const [authorization, setAuthorization] = useState('');
  const [payer, setPayer] = useState('');
  const [walletPayer, setWalletPayer] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  if (!loaded) {
    setLoaded(true);
    void act(() => api.requirePayment(saved.id, saved.token)).then(result => {
      if (!result) return;
      if (result.paid) onPaid(result.request); else { setRequirements(result.accepts[0]); setResource(result.resource); }
    });
  }

  const pay = async (header: string) => {
    const result = await act(() => api.pay(saved.id, saved.token, header));
    if (result) onPaid(result.request);
  };

  return (
    <Card title="Pay for creation">
      {request.status === 'PAYMENT_REVIEW' && (
        <Notice kind="warn">
          The last settlement result was ambiguous, so this request is parked for operator reconciliation.
          You will not be charged twice; retrying will not settle another payment.
        </Notice>
      )}
      {!requirements ? <p className="muted small">Requesting payment requirements…</p> : (
        <>
          <dl className="kv">
            <dt>Amount</dt><dd><strong>{formatUnits(requirements.amount, requirements.extra.assetDecimals)} {config.creation.asset}</strong></dd>
            <dt>Network</dt><dd>{requirements.network} · scheme {requirements.scheme} · x402 v2</dd>
            <dt>Pay to</dt><dd className="mono">{requirements.payTo}</dd>
            <dt>Hedera fee payer</dt><dd className="mono">{requirements.extra.feePayer ?? 'unavailable'}</dd>
            <dt>Nonce</dt><dd className="mono">{requirements.extra.nonce}</dd>
            <dt>Facilitator</dt><dd>{config.creation.facilitator} ({requirements.extra.settlementMode})</dd>
            <dt>Discount</dt><dd>{request.discountBps > 0 ? `${request.discountBps / 100}% applied` : 'not applied'} — {request.discountNote}</dd>
          </dl>
          {config.creation.settlementMode === 'simulated'
            ? <div className="stack">
                <Notice kind="warn">Development settlement: authorizing here records a simulated payment and performs no Hedera transaction.</Notice>
                <div className="field">
                  <label htmlFor="payer">Payer account id</label>
                  <input id="payer" value={payer} onChange={event => setPayer(event.target.value)} placeholder="0.0.1234" />
                </div>
                <button className="primary" disabled={busy || !/^\d+\.\d+\.\d+$/.test(payer)} onClick={() => void pay(
                  btoa(JSON.stringify({ x402Version: 2, resource, accepted: requirements, payload: { payer, nonce: requirements.extra.nonce } })),
                )}>Authorize simulated payment</button>
              </div>
            : <div className="stack">
                <Notice kind="info">
                  Horizon never holds your Hedera key. Your wallet signs a partially signed transfer and Blocky402 adds the advertised fee-payer
                  signature when it settles the x402 request.
                </Notice>
                {config.creation.walletConnectProjectId && resource && (
                  <button className="primary" disabled={busy} onClick={() => void act(async () => {
                    const { createHederaPaymentSignature } = await import('../hedera');
                    const signed = await createHederaPaymentSignature(config.creation.walletConnectProjectId!, resource, requirements);
                    setWalletPayer(signed.accountId);
                    const result = await api.pay(saved.id, saved.token, signed.signature);
                    onPaid(result.request);
                  })}>Pay with Hedera wallet</button>
                )}
                {walletPayer && <p className="small muted">Signed by Hedera account <span className="mono">{walletPayer}</span>.</p>}
                <details>
                  <summary className="small">Agent or advanced client payment</summary>
                  <pre className="small scroll"><code>{JSON.stringify(requirements, null, 2)}</code></pre>
                  <div className="field">
                    <label htmlFor="authorization">Base64 PAYMENT-SIGNATURE authorization</label>
                    <textarea id="authorization" value={authorization} onChange={event => setAuthorization(event.target.value)} />
                  </div>
                  <button disabled={busy || authorization.trim().length < 16} onClick={() => void pay(authorization.trim())}>
                    Submit signed payment
                  </button>
                </details>
              </div>}
          <p className="small muted" style={{ marginTop: '.75rem' }}>
            An agent client uses the same endpoint: POST this resource without a header to receive the 402 requirements,
            then repeat it with the <code>X-PAYMENT</code> header. Retries are idempotent and never charge twice.
          </p>
        </>
      )}
    </Card>
  );
}

function Outcome({ request, busy, onRefresh, onReset }: { request: CreationRequest; busy: boolean; onRefresh: () => Promise<void>; onReset: () => void }) {
  return (
    <Card title="Creation status" actions={<button disabled={busy} onClick={() => void onRefresh()}>Refresh</button>}>
      <dl className="kv">
        <dt>Status</dt><dd>{request.status}</dd>
        <dt>Payment</dt>
        <dd>
          {request.payment
            ? <>{request.payment.status} · {formatUnits(request.payment.amountUnits, 8)} {request.payment.asset} · {request.payment.facilitator}
                {request.payment.transactionRef && <> · <span className="mono">{request.payment.transactionRef}</span></>}</>
            : 'none'}
        </dd>
        <dt>Attempts</dt><dd>{request.attempts}</dd>
        {request.marketAddress && <><dt>Market</dt><dd><a href={`#/markets/${request.marketAddress}`}>{request.marketAddress}</a></dd></>}
        {request.creationTxHash && <><dt>Transaction</dt><dd><TxLink hash={request.creationTxHash} /></dd></>}
        {request.failureCode && <><dt>Failure</dt><dd>{request.failureCode}</dd></>}
      </dl>
      {request.status === 'PAID' && <Notice kind="info">Payment settled. The background worker is deploying the market; this page can be closed and reopened safely.</Notice>}
      {request.status === 'CREATING' && <Notice kind="info">The creation job is running.</Notice>}
      {request.status === 'FAILED' && <Notice kind="error">Creation failed after payment. The paid request stays recoverable and an operator can retry it without another charge.</Notice>}
      {request.status === 'CREATED' && (
        <Notice kind="ok">
          The market is live. It appears in <a href="#/">Markets</a> once The Graph has indexed it.
          <button className="link" style={{ marginLeft: '.5rem' }} onClick={onReset}>Start another request</button>
        </Notice>
      )}
    </Card>
  );
}
