import { useState } from 'react';
import { api, ApiError, type MakerCurve, type Position } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Badge, Card, Empty, ErrorBox, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { dateTime, priceUsdc, shares, timeLeft, usdc } from '../format';
import { confirm, describeWalletError, send } from '../wallet';

export function Holdings() {
  const wallet = useWallet();
  const account = wallet.account;
  const positions = useAsync(async () => account ? api.positions(account) : { indexedBlock: 0, positions: [] as Position[] }, [account]);
  if (!account) {
    return (
      <Card title="Holdings">
        <Empty title="Connect a wallet to see your outcome tokens">
          <p className="small">Balances are read live from the outcome token contracts, not from indexed transfers.</p>
          <button className="primary" onClick={() => void wallet.connect()}>Connect wallet</button>
        </Empty>
      </Card>
    );
  }
  if (positions.loading) return <Loading rows={5} label="Loading holdings" />;
  if (positions.error) return <ErrorBox error={positions.error} retry={positions.reload} />;
  const rows = positions.data!.positions;
  return (
    <div className="stack">
      <div className="row between">
        <h1>Your dashboard</h1>
        <button onClick={positions.reload}>Refresh</button>
      </div>
      <Notice kind="info">
        Outcome tokens are bound to one market and outcome. Holding them creates no sell offer: publish a sell curve when you want to sell.
      </Notice>
      <h2>Outcome tokens</h2>
      {rows.length === 0
        ? <Empty title="No outcome tokens yet"><p className="small">Buy YES or NO in any open market and your position appears here.</p></Empty>
        : <div className="grid">{rows.map(position => <PositionCard key={position.market} position={position} account={account} onDone={positions.reload} />)}</div>}
      <MakerCurves account={account} />
    </div>
  );
}

/** Everything this account has published, so a maker can see and cancel their own liquidity. */
function MakerCurves({ account }: { account: string }) {
  const listing = useAsync(() => api.makerCurves(account), [account]);
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
      if (status === 'success') listing.reload();
    } catch (issue) {
      if (issue instanceof ApiError) { setError(describe(issue.code)); setTx({ phase: 'idle' }); }
      else setTx({ phase: 'error', message: describeWalletError(issue) });
    } finally { setBusy(undefined); }
  };

  if (listing.loading) return <Card title="Your curves"><Loading rows={3} label="Loading your curves" /></Card>;
  if (listing.error) return <Card title="Your curves"><ErrorBox error={listing.error} retry={listing.reload} /></Card>;
  const curves = listing.data!.curves;
  return (
    <Card title="Your curves" actions={<a className="small" href="#/publish">Publish another</a>}>
      {curves.length === 0
        ? <Empty title="You have not published any liquidity yet">
            <p className="small">A curve or a limit order is how you offer to buy or sell an outcome at prices you choose.</p>
            <a className="button" href="#/publish">Publish a curve</a>
          </Empty>
        : <>
            {error && <Notice kind="error">{error}</Notice>}
            <TransactionState state={tx} />
            <div className="scroll">
              <table>
                <thead><tr><th>Market</th><th>Order</th><th>Price</th><th>Filled</th><th>State</th><th /></tr></thead>
                <tbody>
                  {curves.map(curve => (
                    <tr key={curve.orderHash}>
                      <td><a href={`#/markets/${curve.market}`}>{curve.question}</a>
                        <div className="small muted">{curve.marketStatus === 'OPEN' ? timeLeft(curve.closeAt) : curve.marketStatus.toLowerCase()}</div></td>
                      <td><span className={`badge ${curve.side === 'YES' ? 'resolved' : 'no'}`}>{curve.direction} {curve.side}</span>
                        <div className="small muted">{curve.isLimit ? 'limit order' : `curve · ${SHAPE_NAMES[curve.shape] ?? ''}`}</div></td>
                      <td className="small">{curve.isLimit ? priceUsdc(curve.startPrice) : `${priceUsdc(curve.startPrice)} → ${priceUsdc(curve.endPrice)}`}</td>
                      <td className="small">{shares(curve.filled)} / {shares(curve.maxShares)}
                        <div className="muted">{shares(curve.remaining)} left</div></td>
                      <td><span className={`badge ${curve.active ? 'open' : 'closed'}`}>{curve.active ? 'live' : 'inactive'}</span></td>
                      <td>{curve.cancellable && (
                        <button disabled={busy !== undefined} onClick={() => void cancel(curve)}>
                          {busy === curve.orderHash ? 'Cancelling…' : 'Cancel'}
                        </button>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: '.6rem' }}>
              Cancelling withdraws everything this order allocated to Aqua. Terms cannot be edited: publish a new order instead.
              A live curve only fills while the wallet behind it still holds the funds, which are shared with your other markets.
            </p>
          </>}
    </Card>
  );
}

const SHAPE_NAMES: Record<number, string> = { 1: 'linear', 2: 'quadratic', 3: 'cubic' };

function PositionCard({ position, account, onDone }: { position: Position; account: string; onDone: () => void }) {
  const [tx, setTx] = useState<TxState>({ phase: 'idle' });
  const [error, setError] = useState<string | undefined>();
  const resolved = position.status === 'RESOLVED';

  const redeem = async () => {
    setError(undefined); setTx({ phase: 'signing' });
    try {
      const prepared = await api.redeem({ account, market: position.market, recipient: account, yesShares: position.yes, noShares: position.no });
      const hash = await send(account, prepared.transaction);
      setTx({ phase: 'pending', hash });
      const status = await confirm(account, hash);
      setTx(status === 'success' ? { phase: 'confirmed', hash } : { phase: 'error', hash, message: 'The redemption reverted.' });
      if (status === 'success') onDone();
    } catch (issue) {
      if (issue instanceof ApiError) { setError(describe(issue.code)); setTx({ phase: 'idle' }); return; }
      setTx({ phase: 'error', message: describeWalletError(issue) });
    }
  };

  return (
    <Card>
      <div className="row between">
        <Badge kind={position.status === 'OPEN' ? 'open' : resolved ? 'resolved' : 'closed'}>
          {resolved ? `Resolved ${position.result}` : position.status}
        </Badge>
        <span className="small muted">{position.status === 'OPEN' ? timeLeft(position.closeAt) : dateTime(position.closeAt)}</span>
      </div>
      <h3 style={{ marginTop: '.5rem' }}><a href={`#/markets/${position.market}`}>{position.question}</a></h3>
      <dl className="kv">
        <dt>YES</dt><dd>{shares(position.yes)}</dd>
        <dt>NO</dt><dd>{shares(position.no)}</dd>
        {resolved && <><dt>Redeemable</dt><dd>{usdc(position.redeemableUsdc)}{position.result === 'INVALID' && ' (INVALID pays 0.5 USDC per token)'}</dd></>}
      </dl>
      {error && <Notice kind="error">{error}</Notice>}
      <TransactionState state={tx} />
      <div className="row" style={{ marginTop: '.6rem' }}>
        {position.status === 'OPEN' && <>
          <a className="button" href={`#/publish?market=${position.market}&side=yes&direction=sell`}>Sell YES curve</a>
          <a className="button" href={`#/publish?market=${position.market}&side=no&direction=sell`}>Sell NO curve</a>
        </>}
        {resolved && position.redeemableUsdc !== '0' && (
          <button className="primary" disabled={tx.phase === 'signing' || tx.phase === 'pending'} onClick={() => void redeem()}>Redeem {usdc(position.redeemableUsdc)}</button>
        )}
      </div>
    </Card>
  );
}
