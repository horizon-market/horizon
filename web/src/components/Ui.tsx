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
  market_unresolved: 'This market has not been resolved yet.',
  draft_hash_mismatch: 'The draft changed after it was displayed. Reload and review it again.',
  verification_unavailable: 'World verification is unavailable, so the discount cannot be applied.',
  verification_rejected: 'World did not accept the credential.',
  verification_after_payment_requirements: 'Payment requirements were already issued; the price cannot change now.',
  payment_awaiting_reconciliation: 'The last payment result was ambiguous. An operator must reconcile it before anything else happens; you will not be charged twice.',
  payment_in_progress_reconcile: 'A payment for this request is already in progress.',
  payment_invalid: 'The facilitator rejected the payment authorization.',
  payment_declined: 'The facilitator declined to settle this payment.',
  payment_replayed: 'That payment authorization was already used.',
  payment_receiver_not_configured: 'No Hedera receiver account is configured on this API.',
  insufficient_outcome_balance: 'The account does not hold that many outcome tokens.',
  origin_not_allowed: 'This browser origin is not allowed to call the API.',
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

/** Brand-coloured, not green: green is reserved for the YES outcome. */
export function ZeroFee({ children }: { children?: ReactNode }) {
  return (
    <Notice kind="brand">
      <strong>0% trading fees.</strong> No maker, taker, routing or Horizon protocol fee is charged on any trade. Network gas is separate.
      {children}
    </Notice>
  );
}
