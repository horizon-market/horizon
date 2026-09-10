import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Curve } from '../api';
import { averageIn, curveOrders, priceIn, samplesIn, type RestingOrder } from '../curve';
import { priceUsdc, shares as formatShares, short } from '../format';

// The viewBox is kept close to the width the card actually gets, so the axis type is never scaled
// far from the size it was chosen at — a 540-wide box shrinks its ticks to nothing on a phone.
const WIDTH = 420, HEIGHT = 236, LEFT = 44, RIGHT = 14, TOP = 20, BOTTOM = 32;
const PLOT_W = WIDTH - LEFT - RIGHT, PLOT_H = HEIGHT - TOP - BOTTOM;
const STEPS = 48;
// Gridline steps, in micro-USDC. The scale picks the smallest one that covers the prices on screen
// in at most five intervals, so every tick is a figure a trader reads without decoding it.
const STEPS_MICRO = [2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000];
const MAX_INTERVALS = 5;

/**
 * A price band that starts and ends on a round step. Interpolating five ticks across the data range
 * instead would put gridlines on figures like 0.081, which is unreadable on a price axis.
 */
function band(prices: number[]) {
  if (prices.length === 0) return { low: 0, high: 1_000_000, step: 250_000 };
  const min = Math.min(...prices), max = Math.max(...prices);
  const step = STEPS_MICRO.find(size =>
    Math.ceil((max - Math.floor(min / size) * size) / size) <= MAX_INTERVALS) ?? 250_000;
  const low = Math.floor(min / step) * step;
  const intervals = Math.max(2, Math.ceil((max - low) / step));
  // A price never exceeds one USDC, so an axis that would run past it slides down instead.
  return low + intervals * step > 1_000_000
    ? { low: Math.max(0, 1_000_000 - intervals * step), high: 1_000_000, step }
    : { low, high: low + intervals * step, step };
}

type Filter = 'all' | 'buy' | 'sell';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'buy', label: 'Buy' }, { key: 'sell', label: 'Sell' },
];

/**
 * Every curve resting on one outcome, drawn as the pricing function it actually is.
 *
 * A ladder can only state one price per level, which is why curves are kept out of it: a curve's
 * price now says nothing about what its next thousand shares cost. Here each curve is plotted from
 * where it is filled to where it runs out, against a share axis shared by all of them, so their
 * sizes and slopes are comparable at a glance.
 *
 * Everything hover reveals is also reachable from the keyboard: the legend selects a curve, and the
 * slider under the chart moves along it.
 */
export function CurveLiquidity({ curves, isYes, tradable }: { curves: Curve[]; isYes: boolean; tradable: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [pinned, setPinned] = useState<string | undefined>();
  const [hovered, setHovered] = useState<string | undefined>();
  const [quantity, setQuantity] = useState<bigint | undefined>();
  const plot = useRef<HTMLDivElement>(null);
  const outcome = isYes ? 'YES' : 'NO';

  const orders = useMemo(() => curveOrders(curves, isYes), [curves, isYes]);
  const shown = useMemo(
    () => orders.filter(order => filter === 'all' || (filter === 'buy' ? order.viewDirection === 'BUY' : order.viewDirection === 'SELL')),
    [orders, filter]);

  // Selection survives a filter change only while the curve is still on screen.
  useEffect(() => {
    if (pinned && !shown.some(order => order.id === pinned)) setPinned(undefined);
  }, [shown, pinned]);
  // Escape dismisses a pinned curve from anywhere, the way any transient selection should.
  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPinned(undefined); setQuantity(undefined); } };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [pinned]);

  const lines = useMemo(() => shown.map(order => ({ order, samples: samplesIn(order, STEPS) })), [shown]);
  const widest = lines.reduce((most, line) => line.order.remaining > most ? line.order.remaining : most, 1n);
  const scale = useMemo(() => band(lines.flatMap(line => line.samples.map(sample => sample.price))), [lines]);

  const x = (additional: bigint) => LEFT + (Number(additional) / Number(widest)) * PLOT_W;
  const y = (micro: number) => TOP + (1 - (micro - scale.low) / (scale.high - scale.low)) * PLOT_H;
  const sharesAt = (fraction: number) => (widest * BigInt(Math.round(Math.min(1, Math.max(0, fraction)) * 10_000))) / 10_000n;

  const selected = shown.find(order => order.id === pinned);
  // Hover previews a curve; a click or a legend key press selects it and opens the readout below.
  const active = selected ?? shown.find(order => order.id === hovered);
  // A selected curve reads at its own end until a pointer or the slider says otherwise; that is the
  // one quantity every keyboard user can reach without a pointer.
  const at = active ? (quantity !== undefined && quantity <= active.remaining ? quantity : active.remaining) : undefined;

  const select = (order: RestingOrder | undefined, position?: bigint) => {
    setPinned(order?.id);
    setQuantity(order && position !== undefined ? position : undefined);
  };

  /** The curve whose line passes closest to the pointer, so overlapping curves stay separable. */
  const nearest = (event: { clientX: number; clientY: number }) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || lines.length === 0) return undefined;
    const px = ((event.clientX - box.left) / box.width) * WIDTH;
    const py = ((event.clientY - box.top) / box.height) * HEIGHT;
    const position = sharesAt((px - LEFT) / PLOT_W);
    let best: { order: RestingOrder; position: bigint; distance: number } | undefined;
    for (const { order } of lines) {
      const clamped = position > order.remaining ? order.remaining : position;
      const distance = Math.hypot(x(clamped) - px, y(priceIn(order, order.curve.filled + clamped)) - py);
      if (!best || distance < best.distance) best = { order, position: clamped, distance };
    }
    return best;
  };

  const track = (event: { clientX: number; clientY: number }) => {
    const found = nearest(event);
    if (!found) return;
    setHovered(found.order.id);
    if (!pinned || pinned === found.order.id) setQuantity(found.position);
  };

  const path = (samples: { additional: bigint; price: number }[]) =>
    samples.map((sample, index) => `${index === 0 ? 'M' : 'L'} ${x(sample.additional).toFixed(2)} ${y(sample.price).toFixed(2)}`).join(' ');

  const ticks = Array.from({ length: (scale.high - scale.low) / scale.step + 1 }, (_, index) => scale.low + index * scale.step);

  if (orders.length === 0) {
    return (
      <div className="stack">
        <Filters filter={filter} onFilter={setFilter} counts={counts(orders)} />
        <p className="small muted empty-side" style={{ textAlign: 'center' }}>
          No pricing curve is resting on {outcome} right now. Fixed-price orders, if any, are in the limit-order book.
        </p>
      </div>
    );
  }

  return (
    <div className="stack curve-liquidity">
      <Filters filter={filter} onFilter={setFilter} counts={counts(orders)} />
      {shown.length === 0
        ? <p className="small muted empty-side" style={{ textAlign: 'center' }}>No {filter} curve is resting on {outcome}.</p>
        : (
          <div className="curve-plot" ref={plot}
            onPointerMove={track}
            onPointerLeave={() => { setHovered(undefined); if (!pinned) setQuantity(undefined); }}
            onPointerDown={event => { const found = nearest(event); if (found) select(found.order, found.position); }}>
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
              aria-label={`${shown.length} pricing curve${shown.length === 1 ? '' : 's'} on ${outcome}, priced between ${priceUsdc(scale.low)} and ${priceUsdc(scale.high)} across up to ${formatShares(widest)} additional shares. The list below carries the same figures.`}>
              <text className="chart-unit" x={2} y={8}>USDC per {outcome} share</text>
              {ticks.map(tick => (
                <g key={tick}>
                  <line className="chart-grid" x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} />
                  <text className="chart-tick" x={LEFT - 6} y={y(tick) + 3} textAnchor="end">{(tick / 1_000_000).toFixed(3)}</text>
                </g>
              ))}
              {lines.map(({ order, samples }) => {
                const dim = active !== undefined && active.id !== order.id;
                return (
                  <g key={order.id} className={`curve-series ${tone(order)}${dim ? ' dim' : ''}${order.executable ? '' : ' deferred'}`}>
                    <path className="curve-line" d={path(samples)} />
                    <circle className="curve-start" cx={x(0n)} cy={y(samples[0]!.price)} r="3.5" />
                  </g>
                );
              })}
              {active && at !== undefined && (
                <g className={`curve-series ${tone(active)} marker`}>
                  <line className="chart-crosshair" x1={x(at)} x2={x(at)} y1={TOP} y2={TOP + PLOT_H} />
                  <circle className="curve-point" cx={x(at)} cy={y(priceIn(active, active.curve.filled + at))} r="4.5" />
                </g>
              )}
              <line className="chart-axis" x1={LEFT} x2={WIDTH - RIGHT} y1={TOP + PLOT_H} y2={TOP + PLOT_H} />
              <text className="chart-tick" x={LEFT} y={HEIGHT - 17}>0</text>
              <text className="chart-tick" x={WIDTH - RIGHT} y={HEIGHT - 17} textAnchor="end">{formatShares(widest)}</text>
              <text className="chart-unit" x={LEFT + PLOT_W / 2} y={HEIGHT - 4} textAnchor="middle">Additional shares filled from now</text>
            </svg>
            {active && at !== undefined && hovered === active.id && (
              <Tooltip order={active} at={at} outcome={outcome} left={(x(at) / WIDTH) * 100} />
            )}
          </div>
        )}
      <Legend orders={shown} activeId={active?.id} pinnedId={pinned} onSelect={select} outcome={outcome} />
      {selected && at !== undefined
        ? <Details order={selected} at={at} outcome={outcome} tradable={tradable}
            onQuantity={value => setQuantity(value)} onDismiss={() => select(undefined)} />
        : <p className="small muted" style={{ margin: 0 }}>
            Hover a line for a quick reading, or choose one — by click, tap or keyboard — for the full figures and a
            slider that walks along it.
          </p>}
    </div>
  );
}

const counts = (orders: RestingOrder[]) => ({
  all: orders.length,
  buy: orders.filter(order => order.viewDirection === 'BUY').length,
  sell: orders.filter(order => order.viewDirection === 'SELL').length,
});

function Filters({ filter, onFilter, counts }: { filter: Filter; onFilter: (value: Filter) => void; counts: Record<Filter, number> }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Curve direction">
      {FILTERS.map(option => (
        <button key={option.key} role="radio" aria-checked={filter === option.key}
          className={filter === option.key ? 'active' : ''} onClick={() => onFilter(option.key)}>
          {option.label}<span className="count">{counts[option.key]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * BUY and SELL keep the exchange colours the rest of the app uses, in the chart and in the list —
 * and they follow the restated direction, so a green line always bids for the outcome on screen.
 */
const swatch = (order: RestingOrder) => `curve-swatch ${tone(order)}${order.executable ? '' : ' deferred'}`;
const tone = (order: RestingOrder) => order.viewDirection === 'BUY' ? 'buy' : 'sell';

/** What the maker actually published, kept beside the restated label rather than replaced by it. */
const provenance = (order: RestingOrder) => `via ${order.direction} ${order.side}`;

function Legend({ orders, activeId, pinnedId, onSelect, outcome }: {
  orders: RestingOrder[]; activeId?: string; pinnedId?: string; onSelect: (order: RestingOrder | undefined) => void; outcome: string;
}) {
  if (orders.length === 0) return null;
  return (
    <ul className="curve-legend">
      {orders.map(order => (
        <li key={order.id}>
          <button className={`curve-row${activeId === order.id ? ' active' : ''}`} aria-pressed={pinnedId === order.id}
            onClick={() => onSelect(pinnedId === order.id ? undefined : order)}>
            <span className={swatch(order)} aria-hidden="true" />
            <span className="curve-name">
              <strong>{order.viewDirection} {outcome}</strong>
              <span className="muted"> · {short(order.maker)}</span>
              {order.complementary && <span className="flag">{provenance(order)}</span>}
              {!order.executable && <span className="flag">merge</span>}
            </span>
            <span className="curve-figure mono">{priceUsdc(order.price)}</span>
            <span className="curve-figure mono muted">{formatShares(order.remaining)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ order, at, outcome, left }: { order: RestingOrder; at: bigint; outcome: string; left: number }) {
  const average = averageIn(order, at);
  // The plot decides where the tip wants to be; the stylesheet decides whether the card is wide
  // enough to honour it, because a centred tip is better than one hanging off the edge.
  return (
    <div className="curve-tip" style={{ '--tip-x': `${Math.min(88, Math.max(12, left))}%` } as CSSProperties}>
      <div className="row between">
        <strong>{order.viewDirection} {outcome}</strong>
        <span className="muted mono">{short(order.maker)}</span>
      </div>
      {order.complementary && <div className="muted">{provenance(order)}</div>}
      <dl className="kv">
        <dt>Price now</dt><dd className="mono">{priceUsdc(order.price)}</dd>
        {/* Both figures at the hovered quantity, because one share there and all the shares to
            there are different numbers and a trader reads the second one. */}
        <dt>Marginal at +{formatShares(at)}</dt><dd className="mono">{priceUsdc(priceIn(order, order.curve.filled + at))}</dd>
        <dt>Average to there</dt><dd className="mono">{average === undefined ? '—' : priceUsdc(average)}</dd>
        <dt>Remaining</dt><dd className="mono">{formatShares(order.remaining)} {outcome}</dd>
      </dl>
    </div>
  );
}

/**
 * The readout a keyboard reaches. The slider is the whole reason this is not a hover-only surface:
 * it walks the same quantity the pointer sets, and every figure below it follows.
 *
 * Marginal and average are kept apart on purpose. The marginal price is what one more share costs
 * at that point on the curve; the average is what the whole quantity up to that point costs, and it
 * is the only one of the two a trader can actually spend.
 */
function Details({ order, at, outcome, tradable, onQuantity, onDismiss }: {
  order: RestingOrder; at: bigint; outcome: string; tradable: boolean;
  onQuantity: (value: bigint) => void; onDismiss: () => void;
}) {
  const sliderId = useId();
  const marginal = priceIn(order, order.curve.filled + at);
  const average = averageIn(order, at);
  const steps = 100;
  const position = Number((at * BigInt(steps)) / (order.remaining > 0n ? order.remaining : 1n));
  return (
    <div className="curve-detail">
      <div className="row between">
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          <span className={swatch(order)} aria-hidden="true" />
          <strong>{order.viewDirection} {outcome}</strong>
          {order.complementary && <span className="small muted">{provenance(order)}</span>}
          <span className="small muted mono">{short(order.maker)}</span>
        </span>
        <button className="link" onClick={onDismiss}>Dismiss</button>
      </div>
      <div className="field" style={{ margin: 'var(--space-2) 0 0' }}>
        <label htmlFor={sliderId}>Additional shares filled: {formatShares(at)}</label>
        <input id={sliderId} type="range" min={0} max={steps} value={position}
          onChange={event => onQuantity((order.remaining * BigInt(event.target.value)) / BigInt(steps))} />
      </div>
      <dl className="kv total">
        <dt>Price now</dt><dd className="mono">{priceUsdc(order.price)}</dd>
        <dt>Marginal price at +{formatShares(at)}</dt><dd className="mono">{priceUsdc(marginal)}</dd>
        <dt>Average over those {formatShares(at)}</dt><dd className="mono">{average === undefined ? '—' : priceUsdc(average)}</dd>
        <dt>Remaining capacity</dt><dd className="mono">{formatShares(order.remaining)} {outcome}</dd>
      </dl>
      <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
        The marginal price is what one more share costs at that point. The average is what the whole {formatShares(at)} shares cost.
        {tradable && order.executable && ' An order ticket quotes the average, never the marginal price.'}
        {order.complementary && ` The maker published a ${order.direction} on ${order.side}; that is the same trade as a
          ${order.viewDirection} on ${outcome} at one minus its price, which is how it is read here.`}
        {!order.executable && ' Filling it needs sell-and-merge routing, which this release does not support, so it is not depth you can take.'}
        {!tradable && ' Trading in this market has closed, so nothing here can be filled now.'}
      </p>
    </div>
  );
}
