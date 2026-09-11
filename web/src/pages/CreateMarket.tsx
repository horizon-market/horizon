import { lazy, Suspense, useState } from 'react';
import type { RpContext } from '@worldcoin/idkit';
import {
  api, ApiError,
  type AuditTrail, type CreationRequest, type ExistingImport, type ImportPreviewResult, type ImportWarning,
  type MarketDraft, type PaymentRequirements, type PaymentResource, type RequestChild,
} from '../api';
import { useLocalState } from '../hooks';
import { CREATION_LABEL, forgetCreation, isDiscardable, rememberCreation, type Saved } from '../creations';
import { useConfig, useWallet } from '../App';
import { Address, Badge, Card, Notice, TxLink, describe } from '../components/Ui';
import { dateTime, formatUnits, short } from '../format';

const WorldVerification = lazy(() => import('../components/WorldVerification').then(module => ({ default: module.WorldVerification })));

const STEPS = ['Describe', 'Review', 'Verify (optional)', 'Pay', 'Markets'] as const;

const stepFor = (request: CreationRequest | undefined) => {
  if (!request) return 0;
  if (request.status === 'DRAFT') return 1;
  if (request.status === 'APPROVED') return 2;
  if (['PAYMENT_REQUIRED', 'PAYMENT_REVIEW'].includes(request.status)) return 3;
  return 4;
};

/** A standalone request stores one MarketDraft; a group stores its event metadata instead. */
const asDraft = (request: CreationRequest): MarketDraft | null =>
  request.kind === 'GROUP' || !request.draft ? null : request.draft as MarketDraft;

type Act = <T,>(run: () => Promise<T>) => Promise<T | undefined>;
type Mode = 'single' | 'group' | 'import';

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

  const act: Act = async run => {
    setError(undefined); setBusy(true);
    try { return await run(); }
    catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : issue instanceof Error ? issue.message : 'The request failed.'); return undefined; }
    finally { setBusy(false); }
  };

  const start = (result: { request: CreationRequest; accessToken?: string }) => {
    if (!result.accessToken) {
      setError('That request already exists but its access token is not available in this browser.');
      return;
    }
    const key = { id: result.request.id, token: result.accessToken };
    rememberCreation(key); setSaved(key); setRequest(result.request);
  };

  const step = stepFor(request);
  const group = request?.kind === 'GROUP';
  return (
    <div className="stack">
      <h1>{group ? 'Create an event' : 'Create a market'}</h1>
      <div className="steps">
        {STEPS.map((label, index) => <span key={label} className={index < step ? 'done' : index === step ? 'active' : ''}>{index + 1}. {label}</span>)}
      </div>
      <Notice kind="info">
        Market creation is a paid service on Hedera through x402. It is <strong>separate from trading, which has no fee at all</strong>.
        Standard price {formatUnits(config.creation.priceUnits, config.creation.assetDecimals)} {config.creation.asset} per market
        {config.creation.discountBps > 0 && <> · verified humans pay {formatUnits((BigInt(config.creation.priceUnits) * BigInt(10_000 - config.creation.discountBps) / 10_000n).toString(), config.creation.assetDecimals)} {config.creation.asset} per market</>}.
        {' '}An event is charged per market it creates.
      </Notice>
      {config.creation.settlementMode === 'simulated' && (
        <Notice kind="warn">
          This API runs the creation payment in <strong>simulated</strong> settlement mode. No Hedera transaction is performed and every
          record is stored and shown as simulated.
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {!request && <Start busy={busy} account={wallet.account} act={act} onStarted={start} />}
      {request && saved && (
        <div className="stack">
          {group ? <GroupReview request={request} saved={saved} busy={busy} act={act} onChange={setRequest} /> : <Review request={request} />}
          {request.status === 'DRAFT' && (
            <Card title={group ? 'Approve this event and its markets' : 'Approve the exact draft'}>
              <p className="small muted">
                Nothing is charged and no market is created until you approve this exact text. Approval is bound to a hash of
                {group ? ' the event, the markets you selected, their order and the price shown above' : " the draft"},
                so any change has to be reviewed again.
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
          <AuditTrailCard request={request} saved={saved} />
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

// ---------------------------------------------------------------------------
// Choosing what to create.
// ---------------------------------------------------------------------------

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: 'single', label: 'One market', hint: 'A single binary YES/NO question.' },
  { key: 'group', label: 'A group of markets', hint: 'One event containing several binary markets.' },
  { key: 'import', label: 'Import from Polymarket', hint: 'Read an event or market page and review what it would create.' },
];

function Start({ busy, account, act, onStarted }: {
  busy: boolean; account?: string; act: Act; onStarted: (result: { request: CreationRequest; accessToken?: string }) => void;
}) {
  const config = useConfig();
  const importable = config.events.imports.available;
  const [mode, setMode] = useState<Mode>('single');
  const available = MODES.filter(entry => entry.key !== 'import' || importable);
  return (
    <div className="stack">
      <Card title="What are you creating?">
        <div className="seg" role="radiogroup" aria-label="Creation mode">
          {available.map(entry => (
            <button key={entry.key} role="radio" aria-checked={mode === entry.key}
              className={mode === entry.key ? 'active' : ''} onClick={() => setMode(entry.key)}>{entry.label}</button>
          ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>{available.find(entry => entry.key === mode)?.hint}</p>
        {!importable && <p className="small muted" style={{ marginBottom: 0 }}>Importing is not enabled on this deployment.</p>}
      </Card>
      {mode === 'single' && <Describe busy={busy} account={account} act={act} onStarted={onStarted} />}
      {mode === 'group' && <DescribeGroup busy={busy} account={account} act={act} onStarted={onStarted} />}
      {mode === 'import' && <ImportFlow busy={busy} account={account} act={act} onStarted={onStarted} />}
    </div>
  );
}

function Describe({ busy, account, act, onStarted }: {
  busy: boolean; account?: string; act: Act; onStarted: (result: { request: CreationRequest; accessToken?: string }) => void;
}) {
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
      <button className="primary" disabled={busy || tooShort} onClick={() => void act(() => api.createDraft({
        question: question.trim(), requesterKind: 'browser', requester: account ?? 'browser',
        category: category.trim() || undefined, closeAt: closeAt ? new Date(closeAt).toISOString() : undefined,
      }, crypto.randomUUID())).then(result => result && onStarted(result))}>{busy ? 'Drafting…' : 'Draft this market'}</button>
    </Card>
  );
}

type ChildInput = { question: string; outcomeLabel: string };
const emptyChild = (): ChildInput => ({ question: '', outcomeLabel: '' });

/**
 * A manually authored group. Each row becomes its own binary market with its own contracts and
 * collateral; the event is the shared context around them, and the exclusivity choice is what
 * decides whether being in it says anything about the outcomes at all.
 */
function DescribeGroup({ busy, account, act, onStarted }: {
  busy: boolean; account?: string; act: Act; onStarted: (result: { request: CreationRequest; accessToken?: string }) => void;
}) {
  const config = useConfig();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [exclusivity, setExclusivity] = useState<'COLLECTION' | 'EXCLUSIVE'>('COLLECTION');
  const [complete, setComplete] = useState(false);
  const [children, setChildren] = useState<ChildInput[]>([emptyChild(), emptyChild()]);
  const limit = config.events.imports.maxChildren;

  const usable = children.filter(child => child.question.trim().length >= 15 && child.outcomeLabel.trim().length > 0);
  const ready = title.trim().length >= 3 && usable.length >= 1;
  const total = BigInt(config.creation.priceUnits) * BigInt(Math.max(1, usable.length));

  const update = (index: number, patch: Partial<ChildInput>) =>
    setChildren(current => current.map((child, position) => position === index ? { ...child, ...patch } : child));

  return (
    <Card title="Describe the event">
      <p className="small muted">
        Each market below is created and resolved on its own. Being in one event does not link their outcomes
        unless you say the rules pick exactly one winner.
      </p>
      <div className="field">
        <label htmlFor="event-title">Event title</label>
        <input id="event-title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder="Barcelona vs Real Madrid" />
      </div>
      <div className="field">
        <label htmlFor="event-description">Shared context (optional)</label>
        <textarea id="event-description" value={description} maxLength={4000} onChange={event => setDescription(event.target.value)}
          placeholder="What every market in this event is about." />
      </div>
      <div className="fields">
        <div className="field">
          <label htmlFor="event-category">Category (optional)</label>
          <input id="event-category" value={category} maxLength={40} onChange={event => setCategory(event.target.value)} placeholder="Sports" />
        </div>
        <div className="field">
          <label htmlFor="event-rule">Do the rules pick exactly one winner?</label>
          <select id="event-rule" value={exclusivity} onChange={event => setExclusivity(event.target.value as 'COLLECTION' | 'EXCLUSIVE')}>
            <option value="COLLECTION">No — grouped for context only</option>
            <option value="EXCLUSIVE">Yes — exactly one market resolves YES</option>
          </select>
          <div className="hint">
            {exclusivity === 'EXCLUSIVE'
              ? 'Horizon refuses a second YES in this group through its resolution workflow. The market contracts do not enforce it.'
              : 'Nothing links the outcomes; their prices need not add up to 100%.'}
          </div>
        </div>
      </div>
      {exclusivity === 'EXCLUSIVE' && (
        <div className="field">
          <label htmlFor="event-complete">
            <input id="event-complete" type="checkbox" checked={complete} onChange={event => setComplete(event.target.checked)} />
            {' '}These markets cover every possible outcome
          </label>
          <div className="hint">Leave this unticked unless the list is exhaustive; an incomplete list is never shown as the full set.</div>
        </div>
      )}

      <h3 style={{ marginTop: 'var(--space-4)' }}>Markets in this event</h3>
      {children.map((child, index) => (
        <div key={index} className="own-order">
          <div className="row between">
            <span className="small muted">Market {index + 1}</span>
            {children.length > 1 && (
              <button className="link" onClick={() => setChildren(current => current.filter((_, position) => position !== index))}>Remove</button>
            )}
          </div>
          <div className="field">
            <label htmlFor={`child-label-${index}`}>Outcome name</label>
            <input id={`child-label-${index}`} value={child.outcomeLabel} maxLength={80}
              onChange={event => update(index, { outcomeLabel: event.target.value })} placeholder="Barcelona wins" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`child-question-${index}`}>Binary question</label>
            <textarea id={`child-question-${index}`} value={child.question} maxLength={200}
              onChange={event => update(index, { question: event.target.value })} placeholder="Will Barcelona win the match on …?" />
            {child.question.trim().length > 0 && child.question.trim().length < 15 && <div className="error">Write at least 15 characters.</div>}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 'var(--space-3)' }}>
        <button disabled={children.length >= limit} onClick={() => setChildren(current => [...current, emptyChild()])}>Add another market</button>
        {children.length >= limit && <span className="small muted">At most {limit} markets per event.</span>}
      </div>

      <dl className="kv total" style={{ marginTop: 'var(--space-3)' }}>
        <dt>Markets to create</dt><dd>{usable.length}</dd>
        <dt>Creation price</dt>
        <dd><strong>{formatUnits(total.toString(), config.creation.assetDecimals)} {config.creation.asset}</strong> — one charge per market</dd>
      </dl>
      <button className="primary" disabled={busy || !ready} onClick={() => void act(() => api.createGroup({
        requesterKind: 'browser', requester: account ?? 'browser',
        event: { title: title.trim(), description: description.trim() || undefined, category: category.trim() || undefined, exclusivity, outcomesComplete: complete },
        children: usable.map(child => ({ question: child.question.trim(), outcomeLabel: child.outcomeLabel.trim() })),
      }, crypto.randomUUID())).then(result => result && onStarted(result))}>
        {busy ? 'Drafting…' : `Draft ${usable.length} market${usable.length === 1 ? '' : 's'}`}
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Importing.
// ---------------------------------------------------------------------------

const SEVERITY: Record<ImportWarning['severity'], 'error' | 'warn' | 'info'> = { blocking: 'error', review: 'warn', info: 'info' };

function Warnings({ warnings, title }: { warnings: ImportWarning[]; title?: string }) {
  if (warnings.length === 0) return null;
  const worst = warnings.some(warning => warning.severity === 'blocking') ? 'blocking'
    : warnings.some(warning => warning.severity === 'review') ? 'review' : 'info';
  return (
    <Notice kind={SEVERITY[worst]}>
      {title && <strong>{title}</strong>}
      <ul style={{ margin: title ? '.4rem 0 0' : 0, paddingLeft: '1.1rem' }}>
        {warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
      </ul>
    </Notice>
  );
}

function ExistingNotice({ existing }: { existing: ExistingImport }) {
  const created = existing.markets.filter(market => market.marketAddress);
  return (
    <Notice kind="warn">
      <strong>This page has already been imported into Horizon.</strong>{' '}
      {created.length > 0
        ? <>It became <a href={`/events/${existing.slug}`}>{existing.title}</a>, with {created.length} market{created.length === 1 ? '' : 's'} already created.
            Trade those instead of paying to create them again.</>
        : <>An import of it is already in progress as “{existing.title}”. Nothing further is charged; wait for it to finish, or discard it from the browser that started it.</>}
      {created.length > 0 && (
        <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
          {created.map(market => (
            <li key={market.position}><a href={`/markets/${market.marketAddress}`}>{market.outcomeLabel}</a></li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

/** Paste an address, read a preview, choose what to import. Nothing is charged until approval. */
function ImportFlow({ busy, account, act, onStarted }: {
  busy: boolean; account?: string; act: Act; onStarted: (result: { request: CreationRequest; accessToken?: string }) => void;
}) {
  const config = useConfig();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<ImportPreviewResult | undefined>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rejection, setRejection] = useState<{ reason: string; existing?: ExistingImport } | undefined>();

  const fetchPreview = async () => {
    setRejection(undefined);
    const result = await act(() => api.previewImport(url.trim()));
    if (!result) return;
    setPreview(result);
    setSelected(new Set(result.preview.children.filter(child => child.preselected).map(child => child.position)));
  };

  const blocked = preview?.preview.warnings.some(warning => warning.severity === 'blocking') ?? false;
  const supported = preview?.preview.children.filter(child => child.supported) ?? [];
  const unit = BigInt(config.creation.priceUnits);
  const total = unit * BigInt(Math.max(1, selected.size));
  const everything = preview ? supported.length === preview.preview.children.length && selected.size === supported.length : false;

  return (
    <div className="stack">
      <Card title="Import from Polymarket">
        <p className="small muted">
          Paste the address of a Polymarket <strong>event</strong> or <strong>market</strong> page. Horizon reads it through its
          own backend from a fixed Polymarket API address, and imports <strong>definitions only</strong>: the question, the outcome
          names, the resolution criteria, the evidence source and the dates. Polymarket prices, liquidity, volume and settlement
          are never imported and never appear as Horizon data.
        </p>
        <div className="field">
          <label htmlFor="import-url">Polymarket page address</label>
          <input id="import-url" value={url} onChange={event => setUrl(event.target.value)}
            placeholder="https://polymarket.com/event/…" />
          <div className="hint">
            Accepts an event page (<code>/event/…</code> or <code>/sports/&lt;league&gt;/…</code>) or a single market
            (<code>/event/…/…</code>, <code>/market/…</code>). A market address imports its event with only that market selected.
          </div>
        </div>
        <button className="primary" disabled={busy || url.trim().length < 10} onClick={() => void fetchPreview()}>
          {busy ? 'Reading…' : 'Fetch preview'}
        </button>
      </Card>

      {rejection && (
        <div className="stack">
          {rejection.existing
            ? <ExistingNotice existing={rejection.existing} />
            : <Notice kind="error">{describe(rejection.reason)}</Notice>}
        </div>
      )}

      {preview && (
        <div className="stack">
          {preview.existing && <ExistingNotice existing={preview.existing} />}
          <Card
            title={preview.preview.title}
            actions={<a className="small" href={preview.source.url} target="_blank" rel="noreferrer noopener">Source page</a>}
          >
            <div className="row">
              <Badge kind={preview.preview.exclusivity === 'EXCLUSIVE' ? 'warn' : 'closed'}>
                {preview.preview.exclusivity === 'EXCLUSIVE' ? 'Exactly one winner' : 'Collection'}
              </Badge>
              {preview.preview.category && <span className="badge closed">{preview.preview.category}</span>}
              {preview.source.kind === 'market' && <span className="badge closed">One market of this event</span>}
            </div>
            {preview.preview.description && <p className="muted" style={{ marginTop: 'var(--space-3)' }}>{preview.preview.description}</p>}
            <p className="small muted">{preview.preview.exclusivityNote}</p>
            <Warnings warnings={preview.preview.warnings} title="About this event" />
          </Card>

          <Card title={`Outcomes (${preview.preview.children.length})`}>
            <p className="small muted" style={{ marginTop: 0 }}>
              Each one becomes an independent binary market with its own contracts, collateral and resolution.
              Untick anything you do not want; the price below follows what is ticked.
            </p>
            {preview.preview.children.map(child => (
              <ChildPreview key={child.position} child={child}
                checked={selected.has(child.position)} disabled={!child.supported || blocked}
                onToggle={value => setSelected(current => {
                  const next = new Set(current);
                  if (value) next.add(child.position); else next.delete(child.position);
                  return next;
                })} />
            ))}
          </Card>

          <Card title="Total cost">
            <dl className="kv total">
              <dt>Markets selected</dt><dd>{selected.size} of {preview.preview.children.length}</dd>
              <dt>Price per market</dt><dd>{formatUnits(unit.toString(), config.creation.assetDecimals)} {config.creation.asset}</dd>
              <dt>Group total</dt>
              <dd><strong>{formatUnits(total.toString(), config.creation.assetDecimals)} {config.creation.asset}</strong></dd>
              {config.creation.discountBps > 0 && (
                <>
                  <dt>With a verified credential</dt>
                  <dd>{formatUnits((total * BigInt(10_000 - config.creation.discountBps) / 10_000n).toString(), config.creation.assetDecimals)} {config.creation.asset} — the discount applies once to the whole request</dd>
                </>
              )}
            </dl>
            {!everything && selected.size > 0 && (
              <Notice kind="warn">
                You are importing {selected.size} of the {preview.preview.children.length} outcomes on the source page. The event
                will be shown as a selection of markets, never as the complete set of possibilities.
              </Notice>
            )}
            {blocked && <Notice kind="error">This page cannot be imported as it stands. The reasons are listed above.</Notice>}
            <button className="primary" disabled={busy || blocked || selected.size === 0 || Boolean(preview.existing?.inProgress) || (preview.existing?.created ?? 0) > 0}
              onClick={() => void act(() => api.createImport({
                url: preview.source.url, requesterKind: 'browser', requester: account ?? 'browser', positions: [...selected].sort((a, b) => a - b),
              }, crypto.randomUUID())).then(result => {
                if (!result) return;
                if (result.ok) onStarted(result); else setRejection({ reason: result.reason, existing: result.existing });
              })}>
              {busy ? 'Importing…' : `Import ${selected.size} market${selected.size === 1 ? '' : 's'} for review`}
            </button>
            <p className="small muted" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
              Importing only creates a draft you can review. Nothing is charged and no contract is deployed until you approve and pay.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}

function ChildPreview({ child, checked, disabled, onToggle }: {
  child: ImportPreviewResult['preview']['children'][number];
  checked: boolean; disabled: boolean; onToggle: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`own-order ${child.supported ? '' : 'unsupported'}`}>
      <div className="row between">
        <label className="row" style={{ gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onToggle(event.target.checked)} />
          <span><strong>{child.outcomeLabel}</strong></span>
        </label>
        <Badge kind={child.supported ? 'open' : 'no'}>{child.supported ? 'Can be created' : 'Cannot be created'}</Badge>
      </div>
      <div className="small muted" style={{ marginTop: 'var(--space-1)' }}>{child.question}</div>
      <Warnings warnings={child.warnings} />
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide details' : 'Show rules, dates and source'}
      </button>
      {open && (
        <div className="stack" style={{ marginTop: 'var(--space-2)' }}>
          <dl className="kv">
            <dt>Source outcomes</dt><dd>{child.source.outcomes.join(' / ') || '—'}</dd>
            <dt>Trading closes</dt><dd>{child.dates.tradingCloseAt ? dateTime(child.dates.tradingCloseAt) : 'unknown'}</dd>
            <dt>Source start / end</dt>
            <dd>
              {child.dates.sourceGameStart ? dateTime(child.dates.sourceGameStart) : '—'} / {child.dates.sourceEndDate ? dateTime(child.dates.sourceEndDate) : '—'}
            </dd>
            <dt>Source page</dt><dd><a href={child.source.url} target="_blank" rel="noreferrer noopener">{child.source.slug}</a></dd>
          </dl>
          {child.ruleChanges.length > 0 && (
            <Notice kind="info">
              <strong>Changed for Horizon settlement</strong>
              <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
                {child.ruleChanges.map((change, index) => <li key={index}>{change}</li>)}
              </ul>
            </Notice>
          )}
          <details>
            <summary className="small">Source resolution criteria, as published</summary>
            <p className="small scroll" style={{ whiteSpace: 'pre-wrap' }}>{child.source.description || 'The source publishes none.'}</p>
          </details>
          {child.draft && (
            <details>
              <summary className="small">Horizon resolution rules</summary>
              <p className="small scroll" style={{ whiteSpace: 'pre-wrap' }}>{child.draft.rules}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reviewing a request.
// ---------------------------------------------------------------------------

function Review({ request }: { request: CreationRequest }) {
  const draft = asDraft(request);
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
                    <a href={`/markets/${warning.market}`}>{warning.question}</a> — {Math.round(warning.similarity * 100)}% overlap. {warning.reason}
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

const CHILD_BADGE: Record<RequestChild['status'], 'open' | 'closed' | 'resolved' | 'warn' | 'no'> = {
  PENDING: 'open', SKIPPED: 'closed', CREATING: 'warn', CREATED: 'resolved', FAILED: 'no',
};
const CHILD_LABEL: Record<RequestChild['status'], string> = {
  PENDING: 'Selected', SKIPPED: 'Not selected', CREATING: 'Creating', CREATED: 'Created', FAILED: 'Failed',
};

/** The event, its children and the group price, with selection still open while it is a draft. */
function GroupReview({ request, saved, busy, act, onChange }: {
  request: CreationRequest; saved: Saved; busy: boolean; act: Act; onChange: (request: CreationRequest) => void;
}) {
  const config = useConfig();
  const event = request.event;
  const quote = request.groupQuote;
  const editable = request.status === 'DRAFT';
  const selected = request.children.filter(child => child.status !== 'SKIPPED');
  const importReview = request.review?.import;

  const toggle = async (position: number, on: boolean) => {
    const next = new Set(selected.map(child => child.position));
    if (on) next.add(position); else next.delete(position);
    if (next.size === 0) return;
    const result = await act(() => api.selectChildren(saved.id, saved.token, [...next].sort((a, b) => a - b)));
    if (result) onChange(result.request);
  };

  return (
    <div className="stack">
      <Card title={event?.title ?? request.question} actions={<span className="badge closed">{request.status}</span>}>
        <div className="row">
          <Badge kind={event?.exclusivity === 'EXCLUSIVE' ? 'warn' : 'closed'}>
            {event?.exclusivity === 'EXCLUSIVE' ? 'Exactly one winner' : 'Collection'}
          </Badge>
          {event?.category && <span className="badge closed">{event.category}</span>}
          {event && event.source.provider !== 'horizon' && event.source.url && (
            <a className="small" href={event.source.url} target="_blank" rel="noreferrer noopener">Imported from {event.source.provider}</a>
          )}
        </div>
        {event?.description && <p className="muted" style={{ marginTop: 'var(--space-3)' }}>{event.description}</p>}
        <p className="small muted">{event?.exclusivityNote}</p>
        {event?.exclusivity === 'EXCLUSIVE' && (
          <p className="small muted">
            Horizon's resolution workflow refuses a second YES in this group. The market contracts hold no notion of the
            group and do not enforce it, and each market keeps its own collateral.
          </p>
        )}
        {event && !event.outcomesComplete && (
          <Notice kind="warn">
            These markets do not cover every outcome, so the event is shown as a selection of markets rather than the full
            set of possibilities.
          </Notice>
        )}
        {importReview && <Warnings warnings={importReview.eventWarnings} title="From the import" />}
      </Card>

      <Card title={`Markets in this event (${selected.length} selected of ${request.children.length})`}>
        {editable
          ? <p className="small muted" style={{ marginTop: 0 }}>
              Changing the selection reprices the request and invalidates any approval, so it can only be done before you approve.
            </p>
          : <p className="small muted" style={{ marginTop: 0 }}>The selection is fixed once approved.</p>}
        {request.children.map(child => {
          const notes = child.notes?.warnings ?? [];
          const changes = child.notes?.ruleChanges ?? [];
          return (
            <div key={child.position} className="own-order">
              <div className="row between">
                {editable
                  ? <label className="row" style={{ gap: 'var(--space-2)' }}>
                      <input type="checkbox" checked={child.status !== 'SKIPPED'} disabled={busy}
                        onChange={event => void toggle(child.position, event.target.checked)} />
                      <span><strong>{child.outcomeLabel}</strong></span>
                    </label>
                  : <strong>{child.outcomeLabel}</strong>}
                <Badge kind={CHILD_BADGE[child.status]}>{CHILD_LABEL[child.status]}</Badge>
              </div>
              {child.draft && (
                <>
                  <div className="small muted" style={{ marginTop: 'var(--space-1)' }}>{child.draft.question}</div>
                  <div className="small muted">Closes {dateTime(child.draft.closeAt)}</div>
                </>
              )}
              <Warnings warnings={notes} />
              {changes.length > 0 && (
                <details>
                  <summary className="small">{changes.length} change{changes.length === 1 ? '' : 's'} made for Horizon settlement</summary>
                  <ul className="small" style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
                    {changes.map((change, index) => <li key={index}>{change}</li>)}
                  </ul>
                </details>
              )}
              {child.draft && (
                <details>
                  <summary className="small">Resolution rules and evidence source</summary>
                  <p className="small scroll" style={{ whiteSpace: 'pre-wrap' }}>{child.draft.rules}</p>
                  <p className="small muted">Evidence source: {child.draft.evidenceSource}</p>
                </details>
              )}
              {child.marketAddress && (
                <p className="small" style={{ marginBottom: 0 }}>
                  <a href={`/markets/${child.marketAddress}`}>Open this market</a>
                  {child.creationTxHash && <> · <TxLink hash={child.creationTxHash} /></>}
                </p>
              )}
              {child.failureCode && <Notice kind="error">{child.failureDetail ?? child.failureCode}</Notice>}
            </div>
          );
        })}
      </Card>

      <Card title="Group price">
        <dl className="kv total">
          <dt>Markets to create</dt><dd>{selected.length}</dd>
          <dt>Price per market</dt><dd>{formatUnits(config.creation.priceUnits, config.creation.assetDecimals)} {config.creation.asset}</dd>
          <dt>Group total</dt>
          <dd><strong>{quote ? formatUnits(quote.totalUnits, quote.assetDecimals) : '—'} {config.creation.asset}</strong></dd>
          {quote && quote.discountBps > 0 && (
            <>
              <dt>With a verified credential</dt>
              <dd>{formatUnits(quote.discountedTotalUnits, quote.assetDecimals)} {config.creation.asset}</dd>
            </>
          )}
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>{quote?.note}</p>
      </Card>
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
    <Card title="Start something different">
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
        {request.kind === 'GROUP' && ' The discount applies once to the whole request, not once per market.'}
        {' '}Only the credential's nullifier hash and type are stored. Verification is an abuse-resistance signal, not proof of forecasting skill.
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
  const markets = request.children.filter(child => child.status !== 'SKIPPED').length;

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
            <dt>Amount</dt>
            <dd>
              <strong>{formatUnits(requirements.amount, requirements.extra.assetDecimals)} {config.creation.asset}</strong>
              {request.kind === 'GROUP' && <> — one charge covering {markets} market{markets === 1 ? '' : 's'}</>}
            </dd>
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


// ---------------------------------------------------------------------------
// The public audit trail.
// ---------------------------------------------------------------------------

const AUDIT_LABEL: Record<string, string> = {
  DRAFT_APPROVED: 'Draft approved', PAYMENT_SETTLED: 'Payment settled', MARKET_CREATED: 'Market created',
};
const AUDIT_STATUS: Record<string, string> = {
  PENDING: 'Pending', PUBLISHING: 'Publishing', UNCONFIRMED: 'Unconfirmed', PUBLISHED: 'Published', FAILED: 'Not published',
};
const AUDIT_BADGE: Record<string, 'open' | 'closed' | 'resolved' | 'warn' | 'no'> = {
  PENDING: 'open', PUBLISHING: 'open', UNCONFIRMED: 'warn', PUBLISHED: 'resolved', FAILED: 'no',
};

/**
 * What Horizon has published about this request on the Hedera Consensus Service, and what that
 * does and does not mean. Three states are kept apart on purpose: a statement is pending until it
 * reaches consensus, unconfirmed when its submission outcome is unknown, and published only with
 * a consensus timestamp and a sequence number anyone can read back for themselves.
 */
function AuditTrailCard({ request, saved }: { request: CreationRequest; saved: Saved }) {
  const [trail, setTrail] = useState<AuditTrail | undefined>(request.audit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const audit = trail ?? request.audit;
  if (!audit || audit.events.length === 0) return null;
  const verification = new Map((audit.verification ?? []).map(entry => [entry.eventId, entry]));
  const published = audit.events.filter(event => event.status === 'PUBLISHED').length;

  const check = async () => {
    setBusy(true); setError(undefined);
    try { setTrail((await api.getAudit(saved.id, saved.token, true)).audit); }
    catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : 'The mirror node could not be read.'); }
    finally { setBusy(false); }
  };

  return (
    <Card
      title="Public audit trail"
      actions={audit.available && published > 0
        ? <button disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Verify on the mirror node'}</button>
        : undefined}
    >
      <p className="small muted">
        Hedera Consensus Service records <strong>Horizon&rsquo;s own statements</strong> about this request and the order in
        which it made them. It does not independently verify the Hedera payment, the Sepolia deployment, or the eventual
        outcome of a market &mdash; each of those is checked at its own source, and the references published here are what
        let you check them.
      </p>
      {audit.available
        ? <p className="small muted">
            Topic <a className="mono" href={audit.topicUrl ?? '#'} target="_blank" rel="noreferrer">{audit.topicId}</a> on
            Hedera {audit.network} &middot; schema <span className="mono">{audit.schema}</span> &middot; delivery is
            at least once, so a statement whose submission outcome was unknown can appear twice. Deduplicate by event id.
          </p>
        : <Notice kind="info">No topic is configured on this deployment, so nothing has been published yet. Every statement below is recorded and can be published later.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <div className="scroll">
        <table>
          <thead><tr><th>Statement</th><th>Publication</th><th>Consensus timestamp</th><th>Record</th></tr></thead>
          <tbody>
            {audit.events.map(event => {
              const checked = verification.get(event.eventId);
              return (
                <tr key={event.eventId}>
                  <td>
                    {AUDIT_LABEL[event.type] ?? event.type}
                    <div className="small muted mono">{short(event.eventId)}</div>
                  </td>
                  <td>
                    <Badge kind={AUDIT_BADGE[event.status] ?? 'open'}>{AUDIT_STATUS[event.status] ?? event.status}</Badge>
                    {event.status === 'UNCONFIRMED' && <div className="small muted">Submitted; the outcome is unknown and is being reconciled against the mirror node.</div>}
                    {event.failureCode && event.status !== 'PUBLISHED' && <div className="small muted">{event.failureCode}</div>}
                    {checked && <div className="small muted">{checked.matches ? 'Read back from the mirror node and matched byte for byte.' : `Not verified: ${checked.reason ?? 'unknown'}.`}</div>}
                  </td>
                  <td>
                    {event.consensusAt
                      ? <>
                          {dateTime(event.consensusAt)}
                          {event.backfilled && <div className="small muted">Recorded after the fact: this is when Horizon published the statement, not when the event happened ({dateTime(event.occurredAt)}).</div>}
                        </>
                      : <span className="muted">&mdash; <span className="small">not yet at consensus</span></span>}
                  </td>
                  <td>
                    {event.mirrorUrl
                      ? <>
                          <a className="mono" href={event.mirrorUrl} target="_blank" rel="noreferrer">#{event.sequenceNumber}</a>
                          {event.transactionUrl && <> &middot; <a className="mono" href={event.transactionUrl} target="_blank" rel="noreferrer">{short(event.transactionId ?? '')}</a></>}
                        </>
                      : <span className="muted">&mdash;</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * What happened after payment. For a group this is per child: each one is an independent
 * deployment, so a failure names the market that failed and leaves the rest alone. A retry only
 * ever deploys what is missing, and never charges again.
 */
function Outcome({ request, busy, onRefresh, onReset }: { request: CreationRequest; busy: boolean; onRefresh: () => Promise<void>; onReset: () => void }) {
  const config = useConfig();
  const group = request.kind === 'GROUP';
  const selected = request.children.filter(child => child.status !== 'SKIPPED');
  const done = selected.filter(child => child.status === 'CREATED').length;
  const failed = selected.filter(child => child.status === 'FAILED');
  return (
    <Card title="Creation status" actions={<button disabled={busy} onClick={() => void onRefresh()}>Refresh</button>}>
      <dl className="kv">
        <dt>Status</dt><dd>{request.status}{group && <> · {done} of {selected.length} markets created</>}</dd>
        <dt>Payment</dt>
        <dd>
          {request.payment
            ? <>{request.payment.status} · {formatUnits(request.payment.amountUnits, config.creation.assetDecimals)} {config.creation.asset} · {request.payment.facilitator}
                {request.payment.transactionRef && <> · <span className="mono">{request.payment.transactionRef}</span></>}</>
            : 'none'}
        </dd>
        <dt>Attempts</dt><dd>{request.attempts}</dd>
        {request.marketAddress && <><dt>Market</dt><dd><a href={`/markets/${request.marketAddress}`}>{request.marketAddress}</a></dd></>}
        {request.creationTxHash && <><dt>Transaction</dt><dd><TxLink hash={request.creationTxHash} /></dd></>}
        {request.failureCode && <><dt>Failure</dt><dd>{request.failureDetail ?? request.failureCode}</dd></>}
      </dl>

      {group && (
        <div className="scroll">
          <table>
            <thead><tr><th>Outcome</th><th>Status</th><th>Market</th><th>Transaction</th></tr></thead>
            <tbody>
              {selected.map(child => (
                <tr key={child.position}>
                  <td>{child.outcomeLabel}</td>
                  <td>
                    <Badge kind={CHILD_BADGE[child.status]}>{CHILD_LABEL[child.status]}</Badge>
                    {child.failureDetail && <div className="small muted">{child.failureDetail}</div>}
                  </td>
                  <td>{child.marketAddress ? <Address value={child.marketAddress} /> : <span className="muted">—</span>}</td>
                  <td>{child.creationTxHash ? <TxLink hash={child.creationTxHash} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {request.status === 'PAID' && <Notice kind="info">Payment settled. The background worker is creating {group ? 'these markets' : 'the market'}; this page can be closed and reopened safely.</Notice>}
      {request.status === 'CREATING' && <Notice kind="info">The creation job is running.</Notice>}
      {request.status === 'FAILED' && (
        <Notice kind="error">
          {group && failed.length > 0
            ? <>
                {failed.length} of {selected.length} market{failed.length === 1 ? '' : 's'} could not be created.
                The {done} that succeeded exist and are never created again; the background job retries only what is missing,
                and no further payment is taken. Refresh to follow it, or ask an operator to retry the request.
              </>
            : <>Creation failed after payment. The paid request stays recoverable and an operator can retry it without another charge.</>}
        </Notice>
      )}
      {request.status === 'CREATED' && (
        <Notice kind="ok">
          {group
            ? <>All {selected.length} markets are live. They appear under <a href={`/events/${request.event?.slug}`}>{request.event?.title}</a> once The Graph has indexed them.</>
            : <>The market is live. It appears in <a href="/">Markets</a> once The Graph has indexed it.</>}
          <button className="link" style={{ marginLeft: '.5rem' }} onClick={onReset}>Start another request</button>
        </Notice>
      )}
    </Card>
  );
}
