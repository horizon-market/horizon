import { useState } from 'react';
import { api, ApiError, type MakerCurve, type Publication } from './api';
import { describe, type TxState } from './components/Ui';
import { approve as approveSpender, confirm, describeWalletError, send } from './wallet';

/** Shared between the Portfolio and the market page, so an order reads the same in both. */

export type OrderState = 'open' | 'filled' | 'closed' | 'unpublished';

export const ORDER_STATES: Record<OrderState, { label: string; badge: 'open' | 'resolved' | 'closed' | 'warn' }> = {
  open: { label: 'Open', badge: 'open' },
  filled: { label: 'Filled', badge: 'resolved' },
  closed: { label: 'Closed', badge: 'closed' },
  unpublished: { label: 'Not published', badge: 'warn' },
};

export function orderState(curve: MakerCurve): OrderState {
  if (BigInt(curve.remaining) === 0n) return 'filled';
  if (!curve.active) return 'closed';
  // Shipped to Aqua but never admitted by Horizon: the allocation stands and can be withdrawn, but
  // the order cannot fill, so it is not resting liquidity and holds no budget.
  return curve.admitted ? 'open' : 'unpublished';
}

/** Still able to take a fill, which is what a market page cares about. */
export const isLive = (curve: MakerCurve) => orderState(curve) === 'open';

/**
 * Cancelling is the same transaction wherever it is offered. `busy` holds the order hash being
 * cancelled so a list can disable every row while one is in flight.
 */
export function useCancelCurve(account: string, onDone: () => void) {
  const [busy, setBusy] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [error, setError] = useState<string | undefined>();

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

  return { cancel, busy, tx, error };
}

/**
 * Publishing a maker order, shared by the limit ticket and the curve ticket so both behave the
 * same way. It is two transactions:
 *
 * 1. `ship` records the Aqua allocation this order may draw on.
 * 2. `admitCurve` publishes it to the Horizon router, which is where the market's order budget is
 *    checked and the only step that makes the order executable.
 *
 * They cannot be one transaction: Aqua's `ship` has no application callback, so the router cannot
 * be consulted while it runs. Between them the order holds an allocation but can never fill, and
 * the maker either retries the admission or cancels to take the allocation back — which is why the
 * shipped step is remembered rather than restarted.
 */
export type PublishStep = 'ship' | 'admit';

type PublishInput = Parameters<typeof api.publishCurve>[0];

export function usePublishCurve(account: string | undefined, onDone: () => void) {
  const [prepared, setPrepared] = useState<Publication | undefined>();
  const [reviewed, setReviewed] = useState<PublishInput | undefined>();
  const [shipped, setShipped] = useState(false);
  const [step, setStep] = useState<PublishStep | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });

  /** Anything reviewed is void once what was reviewed changes, and so is a half-finished publication. */
  const reset = () => {
    setPrepared(undefined); setReviewed(undefined); setShipped(false);
    setStep(undefined); setTx({ phase: 'idle' }); setError(undefined);
  };

  const review = async (input: PublishInput) => {
    if (!account) return;
    setError(undefined); setChecking(true); setReviewed(input);
    try { setPrepared(await api.publishCurve(input)); }
    catch (issue) { setError(issue instanceof ApiError ? describe(issue.code) : 'Could not prepare the order.'); }
    finally { setChecking(false); }
  };

  const submit = async (phase: PublishStep, request: { to: string; data: string; value: string }) => {
    setStep(phase); setTx({ phase: 'signing' });
    const hash = await send(account!, request);
    setTx({ phase: 'pending', hash });
    const status = await confirm(account!, hash);
    return { hash, ok: status === 'success' };
  };

  const approve = async () => {
    if (!account || !prepared) return;
    setStep(undefined); setTx({ phase: 'signing' });
    try {
      const hash = await approveSpender(account, prepared.approval.token, prepared.approval.spender, prepared.approval.amount);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The approval reverted.' }); return; }
      setTx({ phase: 'confirmed', hash });
      // Re-price the same order against the new allowance. Carrying the salt keeps it the order the
      // maker just reviewed, rather than quietly replacing it with a fresh one.
      if (reviewed) await review({ ...reviewed, salt: prepared.strategy.salt });
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  const publish = async () => {
    if (!account || !prepared) return;
    try {
      if (!shipped) {
        const allocation = await submit('ship', prepared.transaction);
        if (!allocation.ok) { setTx({ phase: 'error', hash: allocation.hash, message: 'Publishing the Aqua allocation reverted.' }); return; }
        setShipped(true);
      }
      const admission = await submit('admit', prepared.admission);
      if (!admission.ok) {
        // The allocation exists and the order is inert. Retrying is free; so is cancelling it.
        setTx({ phase: 'error', hash: admission.hash, message:
          'Horizon did not accept this order. Its market budget may have been committed by another '
          + 'order, or the funds behind it may have moved since this was reviewed. Refresh the '
          + 'figures and try again, or cancel this allocation from your portfolio.' });
        return;
      }
      setTx({ phase: 'confirmed', hash: admission.hash });
      setPrepared(undefined); setShipped(false); setStep(undefined);
      onDone();
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  const working = tx.phase === 'signing' || tx.phase === 'pending';
  return { prepared, shipped, step, checking, error, tx, working, review, approve, publish, reset };
}
