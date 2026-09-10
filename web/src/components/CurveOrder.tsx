import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Publication } from '../api';
import { Notice, TransactionState, describe, type TxState } from './Ui';
import { CurveEditor, curveProblems, decimal, micro, previewOf, reflect, type CurveDraft } from './CurveEditor';
import { parseUnits, priceUsdc, shares as formatShares, USDC_DECIMALS } from '../format';
import { approve, confirm, describeWalletError, send } from '../wallet';

type Side = { isYes: boolean; isBuy: boolean };

/**
 * The third way to rest liquidity, next to the fixed-price order it is a generalisation of. It runs
 * the same review → approve → publish sequence as `LimitOrder`, against the same endpoint; the only
 * difference is that the start and end prices are allowed to differ, which is the whole feature.
 */
export function CurveOrder({ market, side, account, book, onDone }: {
  market: string; side: Side; account?: string;
  book: { ask: number | null; bid: number | null }; onDone: () => void;
}) {
  // Opening prices come from the book, so the first curve a maker sees is already in the market
  // rather than at an arbitrary half a dollar.
  const [draft, setDraft] = useState<CurveDraft>(() => {
    const anchor = ((side.isBuy ? book.bid ?? book.ask : book.ask ?? book.bid) ?? 500_000);
    const away = side.isBuy ? Math.max(1_000, anchor - 100_000) : Math.min(999_000, anchor + 100_000);
    return { isBuy: side.isBuy, start: decimal(anchor), end: decimal(away), shape: 1 };
  });
  const [flipped, setFlipped] = useState<string | undefined>();
  const [size, setSize] = useState('10');
  const [sizeTouched, setSizeTouched] = useState(false);
  const [prepared, setPrepared] = useState<Publication | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });

  // Buy and sell curves run in opposite directions, so a direction change has to move the end price
  // or the order collapses flat. `reflect` keeps the chosen shape and reports what it did.
  useEffect(() => {
    setDraft(current => {
      if (current.isBuy === side.isBuy) return current;
      const next = reflect(current, side.isBuy);
      setFlipped(next.flipped);
      return next.draft;
    });
  }, [side.isBuy]);
  // Nothing reviewed survives a change to what was reviewed.
  useEffect(() => { setPrepared(undefined); setTx({ phase: 'idle' }); setError(undefined); }, [draft, size, side.isYes]);

  const change = (patch: Partial<CurveDraft>) => {
    if (patch.start !== undefined || patch.end !== undefined) setFlipped(undefined);
    setDraft(current => ({ ...current, ...patch }));
  };

  const amount = useMemo(() => {
    try {
      const value = parseUnits(size, USDC_DECIMALS);
      if (value < 1_000_000n) return { error: 'Publish at least one share.' };
      if (value > 10n ** 15n) return { error: 'The maximum curve size is 1,000,000,000 shares.' };
      return { value };
    } catch (issue) { return { error: issue instanceof Error ? issue.message : 'Invalid amount.' }; }
  }, [size]);
  const problems = curveProblems(draft);
  const preview = amount.value ? previewOf(draft, amount.value) : undefined;
  const ready = Boolean(account) && !problems.start && !problems.end && !amount.error;

  const review = async () => {
    if (!account || !ready || !amount.value) return;
    setError(undefined); setBusy(true);
    try {
      setPrepared(await api.publishCurve({
        maker: account, market, isYes: side.isYes, isBuy: side.isBuy,
        startPrice: micro(draft.start), endPrice: micro(draft.end),
        shares: amount.value.toString(), shape: draft.shape,
      }));
    } catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : 'Could not prepare the curve.'); }
    finally { setBusy(false); }
  };

  const run = async (action: 'approve' | 'publish') => {
    if (!account || !prepared) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(account, prepared.approval.token, prepared.approval.spender, prepared.approval.amount)
        : await send(account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'approve') await review(); else { setPrepared(undefined); onDone(); }
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  const working = tx.phase === 'signing' || tx.phase === 'pending';
  return (
    <div className="stack">
      <CurveEditor draft={draft} shares={amount.value ?? 10_000_000n} onChange={change} flipped={flipped} />
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="curve-size">Amount (shares)</label>
        <input id="curve-size" inputMode="decimal" value={size}
          aria-invalid={sizeTouched && amount.error ? true : undefined}
          onBlur={() => setSizeTouched(true)} onChange={event => setSize(event.target.value)} />
        {sizeTouched && amount.error
          ? <div className="error">{amount.error}</div>
          : <div className="hint">One share pays 1 USDC if {side.isYes ? 'YES' : 'NO'} wins.</div>}
      </div>
      {/* What this costs is already on the readout above, in the same figures the contract uses.
          Only what the readout cannot say belongs here: the token count a sell curve puts up, and
          the fee. */}
      <dl className="kv total">
        {!side.isBuy && preview && (
          <>
            <dt>You offer</dt>
            <dd><strong>{formatShares(amount.value!)} {side.isYes ? 'YES' : 'NO'}</strong></dd>
          </>
        )}
        <dt>Fees</dt><dd>0% — no maker, taker, routing or protocol fee</dd>
      </dl>
      <Notice kind="info">
        Your curve rests until someone trades against it, and you can cancel it any time from your{' '}
        <a href="#/holdings">portfolio</a>.
        {side.isBuy && ' A resting bid also funds complementary minting for a trader buying the opposite outcome.'}
      </Notice>
      {!account && <Notice kind="info">Connect a wallet to publish a curve from your own account.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {prepared?.readiness === 'insufficient_balance' && (
        <Notice kind="warn">Not enough {side.isBuy ? 'test USDC' : `${side.isYes ? 'YES' : 'NO'} tokens`} to back this curve.</Notice>
      )}
      {prepared && (
        <dl className="kv">
          <dt>Prices</dt><dd>{priceUsdc(prepared.strategy.startPrice)} → {priceUsdc(prepared.strategy.endPrice)}</dd>
          <dt>Size</dt><dd>{formatShares(prepared.strategy.maxShares)} shares</dd>
          <dt>Order hash</dt><dd className="mono">{prepared.orderHash.slice(0, 18)}…</dd>
        </dl>
      )}
      <TransactionState state={tx} />
      {!prepared
        ? <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={busy || !ready}
            onClick={() => void review()}>{busy ? 'Checking…' : 'Review curve'}</button>
        : prepared.readiness === 'approval_required'
          ? <button className="primary wide" disabled={working} onClick={() => void run('approve')}>
              Approve {side.isBuy ? 'USDC' : 'outcome tokens'} for Aqua
            </button>
          : <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={working || prepared.readiness !== 'ready'}
              onClick={() => void run('publish')}>Publish curve</button>}
    </div>
  );
}
