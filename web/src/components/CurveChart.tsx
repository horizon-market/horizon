import { useId, useMemo, useState } from 'react';
import { priceAt, type CurvePreview, type CurveShape } from '../curve';
import { priceUsdc, shares as formatShares } from '../format';

const WIDTH = 340, HEIGHT = 196, LEFT = 36, RIGHT = 12, TOP = 20, BOTTOM = 26;
const PLOT_W = WIDTH - LEFT - RIGHT, PLOT_H = HEIGHT - TOP - BOTTOM;
// Each shape is labelled where the three curves are furthest apart, so the labels never collide.
const SHAPES: { shape: CurveShape; label: string; at: number }[] = [
  { shape: 1, label: 'α1', at: 0.28 }, { shape: 2, label: 'α2', at: 0.5 }, { shape: 3, label: 'α3', at: 0.72 },
];
const STEPS = 48;

/**
 * The vertical axis keeps zero as its baseline, so the shaded area stays proportional to the
 * USDC the curve actually integrates, but stops just above the curve's own price band instead
 * of always reaching one dollar. That makes the difference between the shapes visible without
 * distorting what the area means.
 */
function scale(curve: CurvePreview) {
  const top = Math.max(curve.startPrice, curve.endPrice);
  const max = Math.min(1_000_000, Math.max(50_000, Math.ceil((top * 1.18) / 50_000) * 50_000));
  return { max, y: (micro: number) => TOP + (1 - micro / max) * PLOT_H };
}
const x = (fraction: number) => LEFT + fraction * PLOT_W;

export function CurveChart({ curve, size }: { curve: CurvePreview; size: bigint }) {
  const gradient = useId();
  const [hover, setHover] = useState<number | undefined>();
  const { max, y } = useMemo(() => scale(curve), [curve.startPrice, curve.endPrice]);
  const path = useMemo(() => (shape: CurveShape) => Array.from({ length: STEPS + 1 }, (_, index) => {
    const fraction = index / STEPS;
    return `${index === 0 ? 'M' : 'L'} ${x(fraction).toFixed(2)} ${y(priceAt({ ...curve, shape }, fraction)).toFixed(2)}`;
  }).join(' '), [curve.startPrice, curve.endPrice, y]);
  const selected = path(curve.shape);
  const area = `${selected} L ${x(1).toFixed(2)} ${y(0).toFixed(2)} L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`;
  const hoverPrice = hover === undefined ? undefined : priceAt(curve, hover);

  return (
    <figure className="chart">
      <figcaption className="small muted">
        {curve.isBuy
          ? 'Your bid falls as the curve fills, so later shares cost you less. The shaded area is the USDC this curve posts.'
          : 'Your ask rises as inventory leaves, so later shares sell for more. The shaded area is the USDC a full fill returns.'}
      </figcaption>
      <div className="chart-plot" onPointerLeave={() => setHover(undefined)}
        onPointerMove={event => {
          const box = event.currentTarget.getBoundingClientRect();
          const fraction = ((event.clientX - box.left) / box.width * WIDTH - LEFT) / PLOT_W;
          setHover(Math.min(1, Math.max(0, fraction)));
        }}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
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
          {SHAPES.filter(other => other.shape !== curve.shape).map(other => (
            <g key={other.shape}>
              <path className="chart-alt" d={path(other.shape)} />
              <text className="chart-alt-label" x={x(other.at)} y={y(priceAt({ ...curve, shape: other.shape }, other.at)) - 5} textAnchor="middle">{other.label}</text>
            </g>
          ))}
          <path className="chart-line" d={selected} />
          {SHAPES.filter(other => other.shape === curve.shape).map(other => (
            <text key={other.shape} className="chart-line-label" x={x(other.at)}
              y={y(priceAt(curve, other.at)) - 7} textAnchor="middle">{other.label}</text>
          ))}
          <circle className="chart-point" cx={x(0)} cy={y(curve.startPrice)} r="4" />
          <circle className="chart-point" cx={x(1)} cy={y(curve.endPrice)} r="4" />
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
