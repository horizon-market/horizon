import { useState } from 'react';
import { Card } from '../components/Ui';
import { CurveChart } from '../components/CurveChart';
import { CurveEditor, SHAPES, bare, money, reflect, type CurveDraft } from '../components/CurveEditor';
import { averagePrice, totalCost, type CurvePreview, type CurveShape } from '../curve';

// The worked example: a hundred shares, bid down from fifty cents to forty.
const EXAMPLE_SHARES = 100_000_000n;
const example = (shape: CurveShape, endPrice = 400_000): CurvePreview =>
  ({ isBuy: true, startPrice: 500_000, endPrice, shape, shares: EXAMPLE_SHARES });
const COMPARISON: CurvePreview[] = SHAPES.map(option => ({
  isBuy: true, startPrice: 620_000, endPrice: 430_000, shape: option.shape, shares: 25_000_000n,
}));

/**
 * What a pricing curve is, for someone who has not met one. It renders from `curve.ts` alone — the
 * same integral the contract runs — so every figure on it is the figure an order would really get,
 * and the page needs no API behind it to be worth reading.
 */
export function Curves() {
  const [draft, setDraft] = useState<CurveDraft>({ isBuy: true, start: '0.62', end: '0.43', shape: 2 });
  const [flipped, setFlipped] = useState<string | undefined>();
  const change = (patch: Partial<CurveDraft>) => { setFlipped(undefined); setDraft(was => ({ ...was, ...patch })); };
  const direction = (isBuy: boolean) => { const next = reflect(draft, isBuy); setDraft(next.draft); setFlipped(next.flipped); };

  return (
    <div className="stack">
      <h1>How pricing curves work</h1>
      <p>
        A limit order rests at one price: every share it fills, it fills at that price. A pricing curve is one
        order that rests across a <em>range</em> of prices and moves through it as it fills — your bid falling as
        you acquire inventory, or your ask rising as inventory leaves. You post it once, and it reprices itself.
      </p>
      <p className="muted">
        The point is the average. A buy curve from 0.50 down to 0.40 fills its first shares near 0.50 and its last
        near 0.40, so the whole order costs less per share than a flat bid at 0.50 would — while still being first
        in line at the top of its range.
      </p>

      <Card title="Try one">
        <p className="small muted" style={{ marginTop: 0 }}>
          Drag either endpoint on the chart, or click one of the dashed lines to change the shape. Nothing here
          touches a wallet or a market — it is 25 shares of arithmetic.
        </p>
        <div className="seg" role="radiogroup" aria-label="Direction">
          <button role="radio" aria-checked={draft.isBuy} className={draft.isBuy ? 'yes' : ''} onClick={() => direction(true)}>Buy</button>
          <button role="radio" aria-checked={!draft.isBuy} className={!draft.isBuy ? 'no' : ''} onClick={() => direction(false)}>Sell</button>
        </div>
        <CurveEditor draft={draft} shares={25_000_000n} onChange={change} flipped={flipped} />
      </Card>

      <h2>The three shapes</h2>
      <p className="small muted">
        Every curve runs between the same two prices. The shape decides <em>when</em> it gives ground: a higher
        exponent sits on the start price longer, then moves more sharply to reach the end.
      </p>
      <div className="grid">
        {COMPARISON.map((curve, index) => (
          <Card key={curve.shape} title={`${SHAPES[index]!.name} · α${curve.shape}`}>
            <CurveChart curve={curve} size={curve.shares} caption={false} />
            <div className="chart-readout" style={{ marginTop: 'var(--space-2)' }}>
              <div><div className="label">Average</div><div className="value">{bare(averagePrice(curve))}</div></div>
              <div><div className="label">USDC posted</div><div className="value">{money(totalCost(curve))}</div></div>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>{SHAPES[index]!.hint}</p>
          </Card>
        ))}
      </div>

      <h2>What it costs</h2>
      <p className="small muted">
        A hundred shares, bid from 0.50. Every figure below is computed with the same integral the contract
        settles against, so it cannot drift from what an order would actually pay.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Order</th><th className="right">Average price</th><th className="right">Total posted (USDC)</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Limit at 0.50</td>
              <td className="right tnum">{bare(averagePrice(example(1, 500_000)))}</td>
              <td className="right tnum">{money(totalCost(example(1, 500_000)))}</td>
            </tr>
            {SHAPES.map(option => (
              <tr key={option.shape}>
                <td>0.50 → 0.40 · {option.name} (α{option.shape})</td>
                <td className="right tnum">{bare(averagePrice(example(option.shape)))}</td>
                <td className="right tnum">{money(totalCost(example(option.shape)))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>A limit order is a curve too</h2>
      <p className="small muted">
        Set the end price equal to the start price and nothing moves as the order fills. That is exactly what the
        contract treats as a fixed price — which is why the trade ticket offers both from one place, and why a
        limit order and a curve cost the same to publish: nothing, beyond network gas.
      </p>
      <div style={{ maxWidth: '30rem' }}>
        <CurveChart curve={example(1, 500_000)} size={EXAMPLE_SHARES} />
      </div>

      <Card title="Publish one">
        <p style={{ marginTop: 0 }}>
          Curves are published from a market, against the book you are competing with. Open any market and choose
          the <strong>Curve</strong> tab in its trade ticket.
        </p>
        <a className="button primary" href="/">Browse markets</a>
      </Card>
    </div>
  );
}
