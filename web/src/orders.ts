import { useState } from 'react';
import { api, ApiError, type MakerCurve } from './api';
import { describe, type TxState } from './components/Ui';
import { confirm, describeWalletError, send } from './wallet';

/** Shared between the Portfolio and the market page, so an order reads the same in both. */

export type OrderState = 'open' | 'filled' | 'closed';

export const ORDER_STATES: Record<OrderState, { label: string; badge: 'open' | 'resolved' | 'closed' }> = {
  open: { label: 'Open', badge: 'open' },
  filled: { label: 'Filled', badge: 'resolved' },
  closed: { label: 'Closed', badge: 'closed' },
};

export function orderState(curve: MakerCurve): OrderState {
  if (BigInt(curve.remaining) === 0n) return 'filled';
  return curve.active ? 'open' : 'closed';
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
