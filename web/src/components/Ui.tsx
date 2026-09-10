import type { ReactNode } from 'react';
import { short } from '../format';

/** The Horizon brandmark. The emblem carries its own dark disc, so it works on both themes. */
export function Logo({ size = 30, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="logo">
      <img src="/brand/brandmark.svg" width={size} height={size} alt={wordmark ? '' : 'Horizon'} aria-hidden={wordmark || undefined} />
      {wordmark && <span className="logo-word">Hori<span>zon</span></span>}
    </span>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && <div className="row between" style={{ marginBottom: '.5rem' }}><h2 style={{ margin: 0 }}>{title}</h2>{actions}</div>}
      {children}
    </section>
  );
}

export function Badge({ kind, children }: { kind: 'open' | 'closed' | 'resolved' | 'warn' | 'no'; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="stack">
      {Array.from({ length: rows }, (_, index) => <div key={index} className="skeleton" style={{ height: index === 0 ? '1.4rem' : '1rem', width: index === 0 ? '60%' : '100%' }} />)}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><p style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</p>{children}</div>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'warn' | 'error' | 'brand'; children: ReactNode }) {
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Notice kind="error">
      <div className="row between">
        <span>{describe(message)}</span>
        {retry && <button className="link" onClick={retry}>Try again</button>}
      </div>
    </Notice>
  );
}

const MESSAGES: Record<string, string> = {
  trading_not_configured: 'The API has no trading configuration, so live market data is unavailable.',
  creation_not_configured: 'The creation service is not configured on this API.',
  graph_unavailable: 'The Graph endpoint did not answer. Market discovery is temporarily unavailable.',
  market_data_unavailable: 'Market data could not be refreshed from the network.',
  market_context_unavailable: 'Live indexed markets could not be read, so a grounded draft cannot be produced right now.',
  quote_unavailable_refresh_or_check_liquidity: 'No executable route was found at this size. Try a smaller size or refresh.',
  quote_capacity: 'Too many quotes are being refreshed at once. Try again in a moment.',
  unauthorized: 'This request belongs to another session.',
  unknown_request: 'That creation request no longer exists in this browser session.',
  unknown_market: 'That market is not registered with the Horizon registry.',
  market_closed: 'Trading in this market has closed.',
  request_abandoned: 'That creation request was discarded and cannot be continued. Start a new one.',
  market_unresolved: 'This market has not been resolved yet.',
  draft_hash_mismatch: 'The draft changed after it was displayed. Reload and review it again.',
  verification_unavailable: 'World verification is unavailable, so the discount cannot be applied.',
  verification_rejected: 'World did not accept the credential.',
  invalid_proof: 'Horizon could not read the World proof. Close the verification window and try again.',
  verification_failed: 'Horizon could not finish verifying the World proof. Please try again.',
  verification_after_payment_requirements: 'Payment requirements were already issued; the price cannot change now.',
  payment_awaiting_reconciliation: 'The last payment result was ambiguous. An operator must reconcile it before anything else happens; you will not be charged twice.',
  payment_in_progress_reconcile: 'A payment for this request is already in progress.',
  payment_invalid: 'The facilitator rejected the payment authorization.',
  payment_declined: 'The facilitator declined to settle this payment.',
  payment_replayed: 'That payment authorization was already used.',
  payment_receiver_not_configured: 'No Hedera receiver account is configured on this API.',
  insufficient_outcome_balance: 'The account does not hold that many outcome tokens.',
  origin_not_allowed: 'This browser origin is not allowed to call the API.',
  // Events, groups and imports.
  events_not_configured: 'Event grouping is not configured on this API.',
  unknown_event: 'That event does not exist on Horizon.',
  event_data_unavailable: 'Event data could not be read right now.',
  imports_not_configured: 'Importing definitions is not enabled on this deployment.',
  import_url_invalid: 'That does not look like a web address. Paste a Polymarket event or market page address.',
  import_url_not_polymarket: 'Only polymarket.com addresses can be imported.',
  import_url_unsupported_path: 'That Polymarket address is not an event or market page. Horizon accepts polymarket.com/event/…, polymarket.com/event/…/…, polymarket.com/market/… and polymarket.com/sports/<league>/… — open the event on Polymarket and copy the address from there.',
  import_source_not_found: 'Polymarket has no event or market at that address.',
  import_source_unavailable: 'Polymarket did not answer. Try again in a moment.',
  import_source_unreadable: 'Polymarket answered with something Horizon could not read.',
  import_market_has_no_event: 'That Polymarket market names no event, so its outcome set cannot be checked.',
  import_not_supported: 'This page cannot be imported as it stands. The reasons are listed against the event and each outcome.',
  import_in_progress: 'This page is already being imported. Nothing further will be charged.',
  already_imported: 'This page has already been imported and its markets exist on Horizon. Trade those instead of creating duplicates.',
  import_selection_empty: 'Select at least one market to create.',
  import_selection_unsupported: 'One of the selected markets cannot be created on Horizon.',
  selection_after_approval: 'The selection is fixed once the request is approved. Discard it and start again to change it.',
  selection_not_available_for_single_request: 'This request creates one market, so there is nothing to select.',
  group_child_count_out_of_range: 'An event must contain between one and twenty-four markets.',
  group_partially_created: 'Some markets in this event could not be created. The ones that succeeded exist and are never created again.',
  exclusive_group_already_resolved: 'Another market in this group is already resolved YES. Exactly one outcome may win, so this would contradict it.',
  exclusive_group_winner_pending: 'A YES resolution is already queued for another market in this group. Exactly one outcome may win.',
};

export function describe(code: string): string {
  return MESSAGES[code] ?? code.replace(/_/g, ' ');
}

export function Address({ value, label }: { value: string; label?: string }) {
  return <a className="mono" href={`https://sepolia.etherscan.io/address/${value}`} target="_blank" rel="noreferrer">{label ?? short(value)}</a>;
}

export function TxLink({ hash }: { hash: string }) {
  return hash.startsWith('0x')
    ? <a className="mono" href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash)}</a>
    : <span className="mono">{short(hash)}</span>;
}

export type TxState = { phase: 'idle' | 'signing' | 'pending' | 'confirmed' | 'error'; hash?: string; message?: string };

export function TransactionState({ state }: { state: TxState }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'signing') return <Notice kind="info">Confirm the request in your wallet…</Notice>;
  if (state.phase === 'pending') return <Notice kind="info">Transaction submitted. Waiting for confirmation… {state.hash && <TxLink hash={state.hash} />}</Notice>;
  if (state.phase === 'confirmed') return <Notice kind="ok">Confirmed on Sepolia. {state.hash && <TxLink hash={state.hash} />}</Notice>;
  return <Notice kind="error">{state.message ?? 'The transaction failed.'}</Notice>;
}

/** How far an order has filled, so a part-filled row reads at a glance rather than by arithmetic. */
export function Fill({ filled, total }: { filled: string; total: string }) {
  const size = BigInt(total);
  const percent = size === 0n ? 0 : Number((BigInt(filled) * 100n) / size);
  return (
    <div className="fill" title={`${percent}% filled`}>
      <span style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

/** Brand-coloured, not green: green is reserved for the YES outcome. */
export function ZeroFee({ children }: { children?: ReactNode }) {
  return (
    <Notice kind="brand">
      <strong>0% trading fees.</strong> No maker, taker, routing or Horizon protocol fee is charged on any trade. Network gas is separate.
      {children}
    </Notice>
  );
}
