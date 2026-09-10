import type { FundingBudget as Budget, MarketBudgets } from '../api';
import type { usePublishCurve } from '../orders';
import { Notice, TransactionState } from './Ui';
import { formatUnits } from '../format';

/**
 * What this wallet may still commit in this market, for the asset the order in front of the maker
 * would actually spend. A buy spends USDC whichever outcome it names, so both directions share one
 * budget; a sell spends that market's YES or NO tokens, and those are separate inventories.
 *
 * None of it is a reservation. USDC stays shared with the wallet's other markets, and a fill,
 * withdrawal or reduced approval anywhere can move these figures at any time.
 */

export const budgetFor = (budgets: MarketBudgets, side: { isYes: boolean; isBuy: boolean }): Budget =>
  side.isBuy ? budgets.usdc : side.isYes ? budgets.yes : budgets.no;

const amount = (value: string, budget: Budget) =>
  `${formatUnits(value, budget.decimals)} ${budget.asset === 'USDC' ? 'USDC' : `${budget.asset} shares`}`;

/**
 * The budget for the asset this order would spend, or an honest account of why it is missing.
 * A budget that could not be read is never shown as an empty one: reviewing an order against a
 * market whose commitments are unknown is exactly what this rule exists to prevent.
 */
export function BudgetSection({ budgets, side, budget, requested }: {
  budgets?: MarketBudgets | null; side: { isYes: boolean; isBuy: boolean };
  budget?: Budget; requested?: bigint;
}) {
  if (budget) return <FundingBudgetPanel budget={budget} requested={requested} />;
  if (budgets === undefined) return <p className="small muted" style={{ margin: 0 }}>Reading this market's order budget…</p>;
  if (budgets === null) {
    return (
      <Notice kind="warn">
        This market's order budget could not be read, so a new order cannot be reviewed here. Refresh and try again.
      </Notice>
    );
  }
  return <FundingBudgetPanel budget={budgetFor(budgets, side)} requested={requested} />;
}

export function FundingBudgetPanel({ budget, requested }: { budget: Budget; requested?: bigint }) {
  const available = BigInt(budget.available);
  const short = requested !== undefined && requested > available;
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <dl className="kv">
        <dt>Funding asset</dt>
        <dd>
          {budget.asset === 'USDC' ? 'USDC' : `${budget.asset} tokens from this market`}
          {budget.asset === 'USDC' && <div className="small muted">Shared with your other markets.</div>}
        </dd>
        <dt>Spendable now</dt>
        <dd>
          {amount(budget.spendable, budget)}
          {BigInt(budget.allowance) < BigInt(budget.balance) && (
            <div className="small muted">Limited by your Aqua approval, not your balance of {amount(budget.balance, budget)}.</div>
          )}
        </dd>
        <dt>Committed in this market</dt>
        <dd>
          {amount(budget.committed, budget)}
          <div className="small muted">
            {budget.orders.length === 0
              ? 'No orders resting here yet.'
              : `${budget.orders.length} resting order${budget.orders.length === 1 ? '' : 's'}: ${
                  budget.orders.map(order => `${order.direction} ${order.side} ${formatUnits(order.remaining, budget.decimals)}`).join(', ')}`}
          </div>
        </dd>
        <dt>Room for another order</dt>
        <dd><strong>{amount(budget.available, budget)}</strong></dd>
      </dl>
      {budget.overcommitted ? (
        <Notice kind="warn">
          This market has {amount(budget.committed, budget)} committed against {amount(budget.spendable, budget)} you can
          currently spend. That happens when shared funds are spent in another market, withdrawn, or the Aqua approval is
          reduced. Existing orders are unchanged and can still fill while the money lasts, but Horizon will not accept a
          new one here until you cancel an order or restore the funds.
        </Notice>
      ) : short && (
        <Notice kind="warn">
          This order needs {amount(requested!.toString(), budget)} and only {amount(budget.available, budget)} is
          uncommitted in this market. Reduce the size, cancel a resting order here, or add funds.
        </Notice>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Nothing is reserved. This check stops one market's orders from promising the same money twice; it does not
        guarantee that any order fills.
      </p>
    </div>
  );
}

/**
 * The review → approve → publish sequence, shared by the limit ticket and the curve ticket.
 *
 * Publishing is two signatures, and this says so rather than presenting one button that silently
 * asks twice. If the allocation lands and the admission does not, the order exists in Aqua but
 * cannot fill, so the sequence resumes at the admission instead of shipping a second allocation.
 */
export function PublishActions({ publication, side, onReview, canReview, labels }: {
  publication: ReturnType<typeof usePublishCurve>;
  side: { isYes: boolean; isBuy: boolean }; onReview: () => void; canReview: boolean;
  labels: { review: string; publish: string };
}) {
  const { prepared, shipped, step, checking, tx, working } = publication;
  const asset = side.isBuy ? 'USDC' : `${side.isYes ? 'YES' : 'NO'} tokens`;
  return (
    <>
      {prepared?.readiness === 'insufficient_balance' && (
        <Notice kind="warn">Not enough {side.isBuy ? 'test USDC' : asset} in this wallet to back this order.</Notice>
      )}
      {prepared?.readiness === 'over_budget' && (
        <Notice kind="warn">
          This wallet holds {formatUnits(prepared.budget.balance, prepared.budget.decimals)} {prepared.budget.asset},
          and this market already has {formatUnits(prepared.budget.committed, prepared.budget.decimals)} of it committed
          to resting orders. This order needs {formatUnits(prepared.budget.requested, prepared.budget.decimals)} more.
          Cancel an order here, reduce the size, or add funds.
        </Notice>
      )}
      {shipped && tx.phase !== 'confirmed' && (
        <Notice kind="warn">
          The Aqua allocation is in place but Horizon has not accepted the order yet, so it cannot fill. Finish the
          publication below, or cancel it from your <a href="/holdings?tab=orders">portfolio</a> to take the allocation back.
        </Notice>
      )}
      {working && step && (
        <p className="small muted" style={{ margin: 0 }}>
          Step {step === 'ship' ? '1 of 2 — allocating funds in Aqua' : '2 of 2 — publishing to Horizon'}.
        </p>
      )}
      <TransactionState state={tx} />
      {!prepared
        ? <button className={`wide ${side.isBuy ? 'yes' : 'no'}`} disabled={checking || !canReview}
            onClick={onReview}>{checking ? 'Checking…' : labels.review}</button>
        : prepared.readiness === 'approval_required'
          ? <button className="primary wide" disabled={working} onClick={() => void publication.approve()}>
              Approve {formatUnits(prepared.approval.amount, prepared.budget.decimals)} {side.isBuy ? 'USDC' : asset} for Aqua
            </button>
          : <button className={`wide ${side.isBuy ? 'yes' : 'no'}`}
              disabled={working || (prepared.readiness !== 'ready' && !shipped)}
              onClick={() => void publication.publish()}>
              {shipped ? 'Finish publication' : labels.publish}
            </button>}
      {prepared?.readiness === 'approval_required' && (
        <p className="small muted" style={{ margin: 0 }}>
          The approval covers this order and the {formatUnits(prepared.budget.committed, prepared.budget.decimals)}{' '}
          {prepared.budget.asset} already committed in this market, so both can be honoured.
        </p>
      )}
    </>
  );
}
