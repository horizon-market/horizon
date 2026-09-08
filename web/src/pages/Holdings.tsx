import { useState } from 'react';
import { api, ApiError, type Position } from '../api';
import { useAsync } from '../hooks';
import { useWallet } from '../App';
import { Badge, Card, Empty, ErrorBox, Loading, Notice, TransactionState, describe, type TxState } from '../components/Ui';
import { dateTime, shares, timeLeft, usdc } from '../format';
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
        <h1>Holdings</h1>
        <button onClick={positions.reload}>Refresh</button>
      </div>
      <Notice kind="info">
        Outcome tokens are bound to one market and outcome. Holding them creates no sell offer: publish a sell curve when you want to sell.
      </Notice>
      {rows.length === 0
        ? <Empty title="No outcome tokens yet"><p className="small">Buy YES or NO in any open market and your position appears here.</p></Empty>
        : <div className="grid">{rows.map(position => <PositionCard key={position.market} position={position} account={account} onDone={positions.reload} />)}</div>}
    </div>
  );
}

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
