import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Quote } from '../api';
import { Notice, TransactionState, type TxState } from './Ui';
import { parseUnits, priceUsdc, usdc, USDC_DECIMALS } from '../format';
import { approve, confirm, describeWalletError, send } from '../wallet';

/**
 * The market-order half of the trade ticket, on its own so the market page and the event page
 * trade through exactly the same control. It owns nothing but the order: the outcome, the
 * direction and what to do afterwards are the caller's, which is what lets an event page put one
 * of these on each of its children without any of them knowing about the others.
 */
export type Side = { isYes: boolean; isBuy: boolean };
export const sideLabel = (side: Side) => `${side.isBuy ? 'Buy' : 'Sell'} ${side.isYes ? 'YES' : 'NO'}`;

/** Takes the best executable route now. The quote it shows is the one the wallet will sign. */
export function MarketOrder({ market, side, account, onDone, onSwitchToLimit, refreshKey = 0 }: {
  market: string; side: Side; account?: string; onDone: () => void; onSwitchToLimit: () => void;
  /** Bumped by the page when the market's liquidity changed on chain: the shown price is re-quoted. */
  refreshKey?: number;
}) {
  const [size, setSize] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<Quote | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | undefined>();
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  // Bumped when an approval confirms: the same order is re-quoted against the new allowance, and
  // the ticket moves on from "Approve" to the trade itself without the trader touching the amount.
  const [approvals, setApprovals] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(timer); }, []);

  const shareAmount = useMemo(() => {
    try {
      const value = parseUnits(size, USDC_DECIMALS);
      return value < 1_000_000n ? { error: 'Minimum order size is 1 share.' } : { value };
    } catch (issue) { return { error: issue instanceof Error ? issue.message : 'Invalid amount.' }; }
  }, [size]);

  // A market order prices itself as you type, the way an exchange ticket does. Each quote refreshes
  // chain state and simulates the whole route, so requests are debounced and single-flight: while
  // one is running the newest inputs wait for it, then supersede it. Firing on every keystroke
  // would queue work the trader has already moved past and exhaust the service's own capacity.
  const inFlight = useRef(false);
  const wanted = useRef<string | undefined>(undefined);
  // A changed order voids whatever the last transaction said; a re-price after an approval keeps
  // that approval's confirmation on screen while the new figures load.
  useEffect(() => { setTx({ phase: 'idle' }); },
    [market, account, side.isYes, side.isBuy, slippageBps, shareAmount.value?.toString(), refreshKey]);
  useEffect(() => {
    setQuote(undefined); setError(undefined);
    if (!account || shareAmount.error || !shareAmount.value) { wanted.current = undefined; return; }
    const request = { market, account, recipient: account, isYes: side.isYes, isBuy: side.isBuy,
      shares: shareAmount.value.toString(), slippageBps };
    const key = JSON.stringify(request);
    wanted.current = key;
    setPending(true);
    const run = async () => {
      if (inFlight.current || wanted.current !== key) return;
      inFlight.current = true;
      try {
        const result = await api.quote(request);
        if (wanted.current === key) { setQuote(result); setPending(false); }
      } catch (issue) {
        if (wanted.current === key) {
          setError(issue instanceof ApiError
            ? { code: issue.code, message: describeQuoteError(issue.code) }
            : { code: 'unknown', message: issue instanceof Error ? issue.message : 'Pricing failed.' });
          setPending(false);
        }
      } finally {
        inFlight.current = false;
        if (wanted.current !== key) void run();
      }
    };
    const timer = setTimeout(() => void run(), 700);
    return () => clearTimeout(timer);
  }, [market, account, side.isYes, side.isBuy, slippageBps, shareAmount.value?.toString(), refreshKey, approvals]);

  const expired = quote ? quote.deadline <= now : false;
  const busy = tx.phase === 'signing' || tx.phase === 'pending';

  const run = async (action: 'approve' | 'execute') => {
    if (!account || !quote) return;
    setTx({ phase: 'signing' });
    try {
      const hash = action === 'approve'
        ? await approve(account, quote.approval.token, quote.approval.spender, quote.approval.amount)
        : await send(account, quote.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      if (status !== 'success') { setTx({ phase: 'error', hash, message: 'The transaction reverted. Prices moved; try again.' }); return; }
      setTx({ phase: 'confirmed', hash });
      if (action === 'execute') onDone();
      else setApprovals(count => count + 1);
    } catch (issue) { setTx({ phase: 'error', message: describeWalletError(issue) }); }
  };

  return (
    <div className="stack">
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="size">Amount (shares)</label>
        <input id="size" inputMode="decimal" value={size} onChange={event => setSize(event.target.value)} />
        {shareAmount.error ? <div className="error">{shareAmount.error}</div>
          : <div className="hint">One share pays 1 USDC if {side.isYes ? 'YES' : 'NO'} wins.</div>}
      </div>
      <details className="small">
        <summary className="muted">Slippage tolerance: {slippageBps / 100}%</summary>
        <select value={slippageBps} onChange={event => setSlippageBps(Number(event.target.value))} style={{ marginTop: '.35rem' }}>
          {[10, 50, 100, 300].map(value => <option key={value} value={value}>{value / 100}%</option>)}
        </select>
      </details>

      {!account && <Notice kind="info">Connect a wallet to price this order against your balances.</Notice>}
      {account && pending && <p className="small muted">Pricing…</p>}
      {quote && (
        <>
          <dl className="kv total">
            <dt>{side.isBuy ? 'Estimated cost' : 'Estimated proceeds'}</dt><dd><strong>{usdc(quote.usdc)}</strong></dd>
            <dt>Average price</dt><dd>{priceUsdc(Number(BigInt(quote.usdc) * 1_000_000n / BigInt(quote.shares)))}</dd>
            <dt>{side.isBuy ? 'Maximum cost' : 'Minimum proceeds'}</dt><dd>{usdc(quote.limit)}</dd>
            <dt>Fees</dt><dd>0% — no maker, taker, routing or protocol fee</dd>
            <dt>Filled from</dt><dd>{quote.legs.length} order{quote.legs.length === 1 ? '' : 's'}, settled atomically</dd>
          </dl>
          {expired
            ? <Notice kind="warn">This price expired. Change the amount to refresh it.</Notice>
            : <p className="small muted">Price held for {Math.max(0, quote.deadline - now)}s and enforced on chain.</p>}
          {quote.simulation === 'insufficient_balance' && (
            <Notice kind="warn">Not enough {side.isBuy ? 'test USDC' : `${side.isYes ? 'YES' : 'NO'} tokens`} in this wallet for that size.</Notice>
          )}
        </>
      )}
      {error && (error.code === 'quote_unavailable_refresh_or_check_liquidity'
        ? <NoLiquidity side={side} onSwitchToLimit={onSwitchToLimit} />
        : <Notice kind="error">{error.message}</Notice>)}
      <TransactionState state={tx} />
      {quote?.simulation === 'approval_required'
        ? <button className="primary wide" disabled={busy || expired} onClick={() => void run('approve')}>
            Approve {side.isBuy ? 'USDC' : 'outcome tokens'}
          </button>
        : <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={busy || expired || quote?.simulation !== 'passed'}
            onClick={() => void run('execute')}>
            {sideLabel(side)}
          </button>}
    </div>
  );
}

/**
 * An empty book is a normal state on a young market. The useful next step is to become the maker,
 * so the invitation switches the ticket rather than sending the trader somewhere else.
 */
function NoLiquidity({ side, onSwitchToLimit }: { side: Side; onSwitchToLimit: () => void }) {
  return (
    <Notice kind="warn">
      <p style={{ margin: '0 0 .5rem' }}>
        Nobody is {side.isBuy ? 'offering' : 'bidding for'} {side.isYes ? 'YES' : 'NO'} at that size right now, so a market order cannot fill.
        Place a limit order at your own price and wait to be filled.
      </p>
      <button onClick={onSwitchToLimit}>Switch to a limit order</button>
    </Notice>
  );
}

function describeQuoteError(code: string): string {
  if (code === 'quote_capacity') return 'The pricing service is busy. Try again in a moment.';
  return code.replace(/_/g, ' ');
}
