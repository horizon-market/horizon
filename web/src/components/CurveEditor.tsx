import { useRef, useState } from 'react';
import { averagePrice, priceAt, totalCost, type CurvePreview, type CurveShape } from '../curve';
import { CurveChart } from './CurveChart';

/**
 * A curve being written, holding its prices as typed rather than as micro-USDC. A half-typed
 * "0." is a state the maker passes through on the way to a real number, so the draft has to be
 * able to hold it; everything numeric derives from here.
 */
export type CurveDraft = { isBuy: boolean; start: string; end: string; shape: CurveShape };

export const micro = (value: string) => Math.round(Number(value.trim()) * 1_000_000);
export const decimal = (value: number) => (value / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

/**
 * The shapes, named for what they do to your price rather than for their exponent. `priceAt` is
 * `start + (end - start) * fraction ** shape`, so a higher shape sits on the start price longer
 * before conceding. The exponent stays on screen as an annotation, because it is what the
 * contract and the API call it.
 */
export const SHAPES: { shape: CurveShape; name: string; hint: string }[] = [
  { shape: 1, name: 'Even', hint: 'Price moves evenly as the order fills.' },
  { shape: 2, name: 'Patient', hint: 'Holds near your start price, then moves faster.' },
  { shape: 3, name: 'Very patient', hint: 'Holds near your start price longest, then moves sharply.' },
];

const PRICE = /^\d*(\.\d{1,6})?$/;

/** One problem per field, so each one can be reported under the input it belongs to. */
export function curveProblems(draft: CurveDraft): { start?: string; end?: string } {
  const problems: { start?: string; end?: string } = {};
  for (const [key, value] of [['start', draft.start], ['end', draft.end]] as const) {
    const trimmed = value.trim();
    if (!trimmed || !PRICE.test(trimmed)) { problems[key] = 'A number with at most six decimals.'; continue; }
    const units = micro(trimmed);
    if (!Number.isInteger(units) || units <= 0 || units >= 1_000_000) problems[key] = 'Must be above 0 and below 1 USDC.';
  }
  if (!problems.start && !problems.end) {
    if (draft.isBuy && micro(draft.end) > micro(draft.start)) problems.end = 'A buy curve cannot end above its start price.';
    if (!draft.isBuy && micro(draft.end) < micro(draft.start)) problems.end = 'A sell curve cannot end below its start price.';
  }
  return problems;
}

export const previewOf = (draft: CurveDraft, shares: bigint): CurvePreview | undefined => {
  const problems = curveProblems(draft);
  if (problems.start || problems.end) return undefined;
  return { isBuy: draft.isBuy, startPrice: micro(draft.start), endPrice: micro(draft.end), shape: draft.shape, shares };
};

/**
 * A buy curve declines as inventory is acquired and a sell curve rises as it leaves, so changing
 * direction has to move the end price or the order collapses into a flat one. Reflecting it across
 * the start price keeps the shape the maker chose — and says so, rather than rewriting a number
 * under their hands and leaving them to notice.
 */
export function reflect(draft: CurveDraft, isBuy: boolean): { draft: CurveDraft; flipped?: string } {
  const start = micro(draft.start), end = micro(draft.end);
  if (draft.isBuy === isBuy || !Number.isFinite(start) || !Number.isFinite(end) || isBuy === (end <= start)) {
    return { draft: { ...draft, isBuy } };
  }
  const reflected = decimal(Math.min(999_000, Math.max(1_000, start * 2 - end)));
  return {
    draft: { ...draft, isBuy, end: reflected },
    flipped: `${isBuy ? 'Buy' : 'Sell'} curves ${isBuy ? 'fall' : 'rise'} as they fill, so the end price flipped to ${reflected}.`,
  };
}

/**
 * The curve itself: the chart, what it costs, and the three controls that shape it. It knows
 * nothing about wallets, markets or publishing, so the trade ticket and the explainer can both
 * hand it a draft and get the same editor back.
 */
export function CurveEditor({ draft, shares, onChange, flipped }: {
  draft: CurveDraft;
  /** Only used to price the curve; the amount field itself belongs to whatever is publishing. */
  shares: bigint;
  onChange: (patch: Partial<CurveDraft>) => void;
  flipped?: string;
}) {
  const [touched, setTouched] = useState<{ start?: boolean; end?: boolean }>({});
  const problems = curveProblems(draft);
  const current = previewOf(draft, shares);
  // A half-typed price would otherwise take the chart off the screen and jump the layout under
  // whoever is typing, so the last good curve stays on show, dimmed, until the number is real.
  const settled = useRef<CurvePreview | undefined>(undefined);
  if (current) settled.current = current;
  const drawn = current ?? settled.current;

  const field = (key: 'start' | 'end', label: string) => (
    <div className="field">
      <label htmlFor={`curve-${key}`}>{label}</label>
      <input id={`curve-${key}`} inputMode="decimal" value={draft[key]}
        aria-invalid={touched[key] && problems[key] ? true : undefined}
        onBlur={() => setTouched(was => ({ ...was, [key]: true }))}
        onChange={event => onChange({ [key]: event.target.value })} />
      {touched[key] && problems[key]
        ? <div className="error">{problems[key]}</div>
        : <div className="hint">{key === 'end' && flipped ? flipped : implied(draft[key])}</div>}
    </div>
  );

  return (
    <div className="stack">
      {/* The chart comes first: it is the thing that explains what the fields below it do. */}
      <div className={drawn && !current ? 'curve-stale' : undefined}>
        {drawn
          ? <CurveChart curve={drawn} size={shares}
              onChange={patch => onChange(
                patch.shape !== undefined
                  ? { shape: patch.shape }
                  : patch.startPrice !== undefined
                    ? { start: decimal(patch.startPrice) }
                    : { end: decimal(patch.endPrice!) })} />
          : <p className="small muted">Enter a start and end price to draw the curve.</p>}
      </div>
      {current && (
        <>
          <p className="chart-summary small">{summarise(current)}</p>
          <div className="chart-readout">
            <div><div className="label">Start</div><div className="value">{bare(current.startPrice)}</div></div>
            <div><div className="label">Half filled</div><div className="value">{bare(priceAt(current, 0.5))}</div></div>
            <div><div className="label">End</div><div className="value">{bare(current.endPrice)}</div></div>
            <div><div className="label">Average</div><div className="value">{bare(averagePrice(current))}</div></div>
            {/* The unit rides in the label so every value in the row is a bare figure; a tile this
                narrow cannot fit "13.91 USDC" on one line. */}
            <div>
              <div className="label">{current.isBuy ? 'USDC posted' : 'USDC returned'}</div>
              <div className="value">{money(totalCost(current))}</div>
            </div>
          </div>
        </>
      )}
      <div className="fields">
        {field('start', 'Start price (USDC per share)')}
        {field('end', 'End price (USDC per share)')}
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label id="curve-shape">Curve shape</label>
        <div className="seg shape-pick" role="radiogroup" aria-labelledby="curve-shape">
          {SHAPES.map(option => (
            <button key={option.shape} role="radio" aria-checked={draft.shape === option.shape}
              className={draft.shape === option.shape ? 'active' : ''}
              title={option.hint} onClick={() => onChange({ shape: option.shape })}>
              <svg viewBox="0 0 48 20" width="48" height="20" aria-hidden="true">
                <path d={spark(option.shape, draft.isBuy)} />
              </svg>
              <span>{option.name}</span>
              <span className="alpha">α{option.shape}</span>
            </button>
          ))}
        </div>
        <div className="hint">{SHAPES.find(option => option.shape === draft.shape)!.hint}</div>
      </div>
    </div>
  );
}

/** The button previews the maths it selects, rather than describing it. */
const spark = (shape: CurveShape, isBuy: boolean) => Array.from({ length: 13 }, (_, index) => {
  const fraction = index / 12, moved = fraction ** shape;
  return `${index === 0 ? 'M' : 'L'} ${(2 + fraction * 44).toFixed(1)} ${(isBuy ? 3 + 14 * moved : 17 - 14 * moved).toFixed(1)}`;
}).join(' ');

const implied = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() ? `${(parsed * 100).toFixed(2)}% implied probability` : 'Between 0 and 1 USDC.';
};

/**
 * One line in place of the paragraph this used to need. The unit is stated once and the totals are
 * rounded to the cent: this is the line you scan, and the readout below it carries the exact
 * figures the order will actually post.
 */
/** Prices to four places, totals to the cent. Shared so the ticket, the readout and the explainer
 *  never present the same figure three different ways. */
export const bare = (value: number) => (value / 1_000_000).toFixed(4);
export const money = (value: bigint) => (Number(value) / 1_000_000).toFixed(2);
const summarise = (curve: CurvePreview) => {
  const rest = `average ${bare(averagePrice(curve))} · ${money(totalCost(curve))} USDC ${curve.isBuy ? 'posted' : 'on a full fill'}`;
  if (curve.startPrice === curve.endPrice) return `Every share fills at ${bare(curve.startPrice)} · ${rest}`;
  const move = `${bare(curve.startPrice)} → ${bare(curve.endPrice)}`;
  return curve.isBuy
    ? `Your bid falls ${move} as it fills · ${rest}`
    : `Your ask rises ${move} as inventory leaves · ${rest}`;
};
