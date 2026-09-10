import { useId, useMemo, useRef, useState, type SVGProps } from 'react';
import { priceAt, type CurvePreview, type CurveShape } from '../curve';
import { priceUsdc, shares as formatShares } from '../format';

const WIDTH = 340, HEIGHT = 196, LEFT = 36, RIGHT = 12, TOP = 20, BOTTOM = 26;
const PLOT_W = WIDTH - LEFT - RIGHT, PLOT_H = HEIGHT - TOP - BOTTOM;
// Each shape is labelled where the three curves are furthest apart, so the labels never collide.
const SHAPES: { shape: CurveShape; label: string; at: number }[] = [
  { shape: 1, label: 'α1', at: 0.28 }, { shape: 2, label: 'α2', at: 0.5 }, { shape: 3, label: 'α3', at: 0.72 },
];
const STEPS = 48;
// A price is an integer number of micro-USDC, strictly between nothing and one dollar.
const FLOOR = 1_000, CEILING = 999_000;
// Dragging lands on a tenth of a cent: finer than one pixel of this plot, and still a clean figure.
// Typing keeps the full six decimals the contract accepts.
const SNAP = 1_000;

type Patch = Partial<Pick<CurvePreview, 'startPrice' | 'endPrice' | 'shape'>>;
type Handle = 'startPrice' | 'endPrice';

/**
 * The vertical axis keeps zero as its baseline, so the shaded area stays proportional to the
 * USDC the curve actually integrates, but stops just above the curve's own price band instead
 * of always reaching one dollar. That makes the difference between the shapes visible without
 * distorting what the area means. An editable chart takes more headroom, because the band on
 * screen is also how far one drag can reach.
 */
const scale = (curve: CurvePreview, headroom: number) =>
  Math.min(1_000_000, Math.max(50_000, Math.ceil((Math.max(curve.startPrice, curve.endPrice) * headroom) / 50_000) * 50_000));
const x = (fraction: number) => LEFT + fraction * PLOT_W;

export function CurveChart({ curve, size, onChange, caption = true }: {
  curve: CurvePreview;
  size: bigint;
  /** Present ⇒ editor mode: the endpoints are draggable and the shape lines are clickable. */
  onChange?: (patch: Patch) => void;
  /** Off where several charts sit together and would otherwise repeat one sentence verbatim. */
  caption?: boolean;
}) {
  const gradient = useId();
  const [hover, setHover] = useState<number | undefined>();
  const [dragging, setDragging] = useState<Handle | undefined>();
  const plot = useRef<HTMLDivElement>(null);
  // A drag that ends on top of a shape line would otherwise be reported as a click on it and
  // change the shape the maker was in the middle of pricing.
  const moved = useRef(false);
  // Which handle the gesture owns. This is a ref and not just the state below because the first
  // pointer moves can arrive before React has re-rendered with the state set at pointer-down, and
  // a handler reading stale state would discard the opening of every quick drag.
  const active = useRef<Handle | undefined>(undefined);
  // The axis is frozen for the length of a drag. Re-deriving it from the very price being dragged
  // would move the whole plot under the pointer, so the curve would run away from the finger
  // holding it. The cost is that one gesture reaches only as far as the band on screen, which the
  // wider editing headroom above is there to offset; the keyboard and the number field have the
  // full range.
  const frozen = useRef<number | undefined>(undefined);
  const live = scale(curve, onChange ? 1.4 : 1.18);
  const max = dragging !== undefined && frozen.current !== undefined ? frozen.current : live;
  const y = useMemo(() => (micro: number) => TOP + (1 - micro / max) * PLOT_H, [max]);

  const path = useMemo(() => (shape: CurveShape) => Array.from({ length: STEPS + 1 }, (_, index) => {
    const fraction = index / STEPS;
    return `${index === 0 ? 'M' : 'L'} ${x(fraction).toFixed(2)} ${y(priceAt({ ...curve, shape }, fraction)).toFixed(2)}`;
  }).join(' '), [curve.startPrice, curve.endPrice, y]);
  const flat = curve.startPrice === curve.endPrice;
  const selected = path(curve.shape);
  const area = `${selected} L ${x(1).toFixed(2)} ${y(0).toFixed(2)} L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`;
  const hoverPrice = hover === undefined ? undefined : priceAt(curve, hover);

  /**
   * A buy curve declines and a sell curve rises, so the two endpoints may not cross. Dragging
   * clamps against the other endpoint rather than reporting a problem: a gesture should never be
   * able to produce an invalid order.
   */
  const clamp = (handle: Handle, micro: number, ceiling: number) => {
    const bounded = Math.min(ceiling, Math.max(FLOOR, Math.round(micro)));
    if (handle === 'startPrice') return curve.isBuy ? Math.max(bounded, curve.endPrice) : Math.min(bounded, curve.endPrice);
    return curve.isBuy ? Math.min(bounded, curve.startPrice) : Math.max(bounded, curve.startPrice);
  };
  const set = (handle: Handle, micro: number, ceiling: number) => onChange?.({ [handle]: clamp(handle, micro, ceiling) } as Patch);
  // Capture can also be lost without a pointer-up — a context menu, a window switch — and a handle
  // still stuck to the pointer after that is the worst failure this control has.
  const release = () => { active.current = undefined; frozen.current = undefined; setDragging(undefined); };

  const drag = (handle: Handle): SVGProps<SVGGElement> => onChange ? {
    className: 'chart-handle',
    tabIndex: 0,
    role: 'slider',
    'aria-label': handle === 'startPrice' ? 'Start price' : 'End price',
    'aria-valuemin': FLOOR / 1_000_000,
    'aria-valuemax': CEILING / 1_000_000,
    'aria-valuenow': curve[handle] / 1_000_000,
    'aria-valuetext': priceUsdc(curve[handle]),
    onPointerDown: event => {
      event.currentTarget.setPointerCapture(event.pointerId);
      frozen.current = live;
      active.current = handle;
      moved.current = false;
      setHover(undefined);
      setDragging(handle);
    },
    onPointerMove: event => {
      if (active.current !== handle) return;
      const box = plot.current?.getBoundingClientRect();
      if (!box) return;
      moved.current = true;
      // Read the frozen band from the ref for the same reason: it is set at pointer-down, one
      // render before `max` catches up.
      const ceiling = frozen.current ?? live;
      const py = ((event.clientY - box.top) / box.height) * HEIGHT;
      set(handle, Math.round((ceiling * (1 - (py - TOP) / PLOT_H)) / SNAP) * SNAP, ceiling);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    // Everything the pointer reaches, the keyboard reaches too — and without the frozen band, so
    // an arrow key can walk a price the whole way to either end.
    onKeyDown: event => {
      const step = event.shiftKey ? 10_000 : SNAP;
      const by: Record<string, number> = {
        ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 50_000, PageDown: -50_000,
      };
      if (event.key in by) { event.preventDefault(); set(handle, curve[handle] + by[event.key]!, CEILING); return; }
      if (event.key === 'Home') { event.preventDefault(); set(handle, FLOOR, CEILING); return; }
      if (event.key === 'End') { event.preventDefault(); set(handle, CEILING, CEILING); }
    },
  } : {};

  return (
    <figure className="chart">
      {caption && <figcaption className="small muted">
        {flat
          ? `Every share fills at the same price, so this is a fixed-price limit order. The shaded area is the USDC ${curve.isBuy ? 'this order posts' : 'a full fill returns'}.`
          : curve.isBuy
            ? 'Your bid falls as the curve fills, so later shares cost you less. The shaded area is the USDC this curve posts.'
            : 'Your ask rises as inventory leaves, so later shares sell for more. The shaded area is the USDC a full fill returns.'}
        {onChange && ' Drag either endpoint to reprice it.'}
      </figcaption>}
      <div ref={plot} className={`chart-plot${onChange ? ' editing' : ''}${dragging ? ' dragging' : ''}`}
        onPointerLeave={() => setHover(undefined)}
        onPointerMove={event => {
          // A drag owns the pointer; letting the crosshair follow it too would have the two fight.
          if (dragging !== undefined) return;
          const box = event.currentTarget.getBoundingClientRect();
          const fraction = ((event.clientX - box.left) / box.width * WIDTH - LEFT) / PLOT_W;
          setHover(Math.min(1, Math.max(0, fraction)));
        }}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role={onChange ? 'group' : 'img'}
          aria-label={`Price moves from ${priceUsdc(curve.startPrice)} to ${priceUsdc(curve.endPrice)} across ${formatShares(size)} shares on shape alpha ${curve.shape}.`}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <text className="chart-unit" x={2} y={10}>USDC per share</text>
          {[0, 0.25, 0.5, 0.75, 1].map(level => (
            <g key={level}>
              <line className="chart-grid" x1={LEFT} x2={WIDTH - RIGHT} y1={y(level * max)} y2={y(level * max)} />
              <text className="chart-tick" x={LEFT - 6} y={y(level * max) + 3} textAnchor="end">{(level * max / 1_000_000).toFixed(2)}</text>
            </g>
          ))}
          <path fill={`url(#${gradient})`} d={area} />
          {(flat ? [] : SHAPES.filter(other => other.shape !== curve.shape)).map(other => (
            <g key={other.shape}>
              <path className="chart-alt" d={path(other.shape)} />
              {/* The chart already draws the shapes it is not using; in editor mode they are the
                  fastest way to switch to one, so they carry a fat invisible line to aim at. */}
              {onChange && <path className="chart-alt-hit" d={path(other.shape)} onClick={() => { if (!moved.current) onChange({ shape: other.shape }); }} />}
              <text className="chart-alt-label" x={x(other.at)} y={y(priceAt({ ...curve, shape: other.shape }, other.at)) - 5} textAnchor="middle">{other.label}</text>
            </g>
          ))}
          <path className="chart-line" d={selected} />
          {(flat ? [] : SHAPES.filter(other => other.shape === curve.shape)).map(other => (
            <text key={other.shape} className="chart-line-label" x={x(other.at)}
              y={y(priceAt(curve, other.at)) - 7} textAnchor="middle">{other.label}</text>
          ))}
          {(['startPrice', 'endPrice'] as const).map(handle => (
            <g key={handle} {...drag(handle)}>
              {/* The visible dot is a four-unit circle; the target you actually have to hit is not. */}
              {onChange && <circle className="chart-hit" cx={x(handle === 'startPrice' ? 0 : 1)} cy={y(curve[handle])} r="11" />}
              <circle className="chart-point" cx={x(handle === 'startPrice' ? 0 : 1)} cy={y(curve[handle])} r="4" />
            </g>
          ))}
          {hover !== undefined && hoverPrice !== undefined && (
            <g>
              <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={TOP} y2={TOP + PLOT_H} />
              <circle className="chart-point hover" cx={x(hover)} cy={y(hoverPrice)} r="4.5" />
            </g>
          )}
          <line className="chart-axis" x1={LEFT} x2={WIDTH - RIGHT} y1={TOP + PLOT_H} y2={TOP + PLOT_H} />
          <text className="chart-tick" x={LEFT} y={HEIGHT - 8}>0% filled</text>
          <text className="chart-tick" x={WIDTH - RIGHT} y={HEIGHT - 8} textAnchor="end">100%</text>
        </svg>
        {hover !== undefined && hoverPrice !== undefined && (
          <div className="chart-tip" style={{ left: `${(x(hover) / WIDTH) * 100}%` }}>
            <strong>{priceUsdc(hoverPrice)}</strong>
            <span>at {Math.round(hover * 100)}% filled</span>
          </div>
        )}
      </div>
    </figure>
  );
}
