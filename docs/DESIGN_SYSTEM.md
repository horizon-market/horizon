# Horizon design system

The tokens live in [`web/src/styles.css`](../web/src/styles.css). The living reference — every
token and every component rendered from the real code, with a theme switch — is the application
route **`/design`**, deliberately absent from the navigation like the operator screen. It renders
from tokens alone, so it works without a configured API behind it.

Dark is the default theme. Light is the alternate, offered to anyone whose system asks for it.

## The three layers

Declared in this order in `styles.css`, and never out of it.

| Layer | Holds | Read by |
| --- | --- | --- |
| **Primitive** | Raw brand ramps: `--navy-*`, `--cyan-*`, `--green-*`, `--red-*`, `--amber-*`, `--neutral-*`, plus `--ink-*` shadow channels | The semantic layer only |
| **Semantic** | What a colour is *for*: `--bg`, `--surface`, `--text`, `--accent`, `--yes`, `--no`, `--warn`, `--brand`, their `-soft`/`-border`/`on-` companions, `--focus`, `--shadow-*` | Components |
| **Component** | Per-component rules consuming semantic tokens | — |

The rule that keeps this honest: **no component rule contains a raw colour value**, and no
component reads a primitive. Verified by grep — the component layer contains zero hex values and
zero `rgb()` literals.

## Colour semantics

Strict, and stated precisely so it does not contradict itself:

- **In data and controls** — prices, ladders, price tiles, outcome buttons, order-side segments —
  green means YES and buy, red means NO and sell. Exclusively. Nothing else in a ladder or a tile
  may be green or red.
- **In notices** — green means an action succeeded, red means it failed. A banner of prose is
  never mistaken for an outcome.
- **Cyan** is interaction: links, focus, primary buttons, the active nav item, selection.
- **Aqua** is a product claim. The zero-fee statement is aqua, never green, so that green keeps
  meaning YES. In dark theme `--brand` is aqua (`--cyan-100`) while `--accent` is cyan
  (`--cyan-400`), so a claim never reads as a control.
- **Amber** is caution and pending. It is never an outcome.

Outcome identity never depends on colour alone. In the ladder, ask and bid are separated by
position and by the spread row; a level that cannot be filled in this release carries the literal
label `merge` beside its price as well as a muted, dotted-underlined price. Deferred rows do
**not** use opacity — that would drop them below the contrast minimum.

## Palette

Brand anchors from `horizon_brand/README.md`: deep navy `#031B47` (`--navy-900`), mid blue
`#063A82` (`--navy-700`), cyan `#1CDDEB` (`--cyan-400`), light aqua `#A8FFF9` (`--cyan-100`).

### Dark (default)

| Semantic | Value | Role |
| --- | --- | --- |
| `--bg` | `#02102A` | Page ground |
| `--surface` | `#061C40` | Cards, top bar |
| `--surface-2` | `#0B2A5A` | Tiles, ladder, inset panels |
| `--surface-3` | `#123268` | Hover, skeleton highlight |
| `--border` | `#153A72` | Decorative hairline |
| `--border-strong` | `#4E7EC0` | Control boundaries (inputs, buttons) |
| `--text` | `#E9F1FB` | Body |
| `--muted` | `#9DB3D2` | Secondary |
| `--accent` | `#1CDDEB` | Interaction |
| `--brand` | `#A8FFF9` | Product claims |
| `--yes` | `#57DFA2` | YES / buy / success |
| `--no` | `#FF9179` | NO / sell / failure |
| `--warn` | `#E9BA63` | Caution |

### Light (alternate)

| Semantic | Value | Role |
| --- | --- | --- |
| `--bg` | `#F3F6FB` | Page ground |
| `--surface` | `#FFFFFF` | Cards, top bar |
| `--surface-2` | `#EAF0F8` | Tiles, ladder, inset panels |
| `--surface-3` | `#DEE8F5` | Hover, skeleton highlight |
| `--border` | `#D3DEEC` | Decorative hairline |
| `--border-strong` | `#7A8BA6` | Control boundaries |
| `--text` | `#05132E` | Body |
| `--muted` | `#51617A` | Secondary |
| `--accent` | `#063A82` | Interaction |
| `--brand` | `#0B5F72` | Product claims |
| `--yes` | `#0F7B52` | YES / buy / success |
| `--no` | `#A5341F` | NO / sell / failure |
| `--warn` | `#7C5100` | Caution |

Cyan `#1CDDEB` is not used as the light-theme accent: at 1.6:1 against white it cannot carry text
or a filled control. Light theme uses the brand mid blue instead, and reserves deep cyan for the
brand role.

## Measured contrast

Computed with the WCAG 2.1 relative-luminance formula against the real background each colour sits
on. These are measurements, not assertions.

| Pair | Dark | Light | Minimum |
| --- | --- | --- | --- |
| Text on page ground | 16.61 | 17.02 | 4.5 |
| Text on surface | 14.78 | 18.44 | 4.5 |
| Text on surface-2 | 12.35 | 16.08 | 4.5 |
| Muted on surface | 7.86 | 6.29 | 4.5 |
| Muted on surface-2 | 6.57 | 5.48 | 4.5 |
| Accent link on surface | 10.09 | 10.85 | 4.5 |
| Label on accent fill (`--on-accent`) | 11.34 | 10.85 | 4.5 |
| Accent on accent-soft | 8.10 | 9.19 | 4.5 |
| Brand on brand-soft | 9.43 | 6.42 | 4.5 |
| Label on brand fill (`--on-brand`) | 16.52 | 7.26 | 4.5 |
| YES on surface | 10.00 | 5.28 | 4.5 |
| YES on yes-soft | 8.59 | 4.61 | 4.5 |
| YES ladder price on surface-2 | 8.36 | 4.61 | 4.5 |
| Label on YES fill (`--on-yes`) | 11.24 | 5.28 | 4.5 |
| NO on surface | 7.68 | 6.75 | 4.5 |
| NO on no-soft | 7.68 | 5.79 | 4.5 |
| NO ladder price on surface-2 | 6.42 | 5.89 | 4.5 |
| Label on NO fill (`--on-no`) | 8.63 | 6.75 | 4.5 |
| Caution on surface | 9.35 | 6.92 | 4.5 |
| Caution on warn-soft | 8.55 | 6.17 | 4.5 |
| `--border-strong` on surface (non-text) | 4.06 | 3.46 | 3.0 |
| Focus ring on page ground (non-text) | 11.34 | 10.02 | 3.0 |

Every pair above meets its minimum. One deliberate exception: `--border` is **1.51** (dark) and
**1.36** (light) against its surface. It is a decorative hairline separating same-purpose regions,
which WCAG 1.4.11 does not cover. Every boundary that defines a control — input, select, textarea,
button — uses `--border-strong`, which meets 3:1 in both themes. Do not use `--border` on a
control.

Re-measure with the script in this repo's session scratchpad, or any WCAG contrast calculator,
after changing a value.

## Type

| Family | Token | Used for |
| --- | --- | --- |
| Space Grotesk | `--font-display` | Headings, prices, chart readouts, the wordmark |
| Inter | `--font-sans` | All UI text |
| JetBrains Mono | `--font-mono` | Ladder, addresses, transaction hashes, code |

Loaded from Google Fonts in `web/index.html` with `display=swap`, preconnects, and a full system
fallback stack in each `--font-*` token, so the app is legible before the fonts land.

| Token | Size | Used for |
| --- | --- | --- |
| `--text-3xl` | 40px | Hero figures |
| `--text-2xl` | 32px | Prices — the loudest element on a card |
| `--text-xl` | 26px | Page headings (`h1`) |
| `--text-lg` | 20px | Section headings |
| `--text-md` | 17px | Card headings (`h2`) |
| `--text-base` | 15px | Body |
| `--text-sm` | 13px | Secondary rows, the ladder |
| `--text-xs` | 12px | Badges, table headers, hints |
| `--text-2xs` | 11px | Axis ticks, chart units |

Weights `--weight-regular|medium|semibold|bold`, line heights `--leading-tight|snug|base`, tracking
`--tracking-tight|base|wide`.

**Numerals are the content of this product.** `font-variant-numeric: tabular-nums` is applied to
table cells, `dl.kv` values, price tiles, chart readouts, ladder levels, badges, the fee chip and
anything with `.mono`. Use the `.tnum` utility for anything those selectors miss. A figure that can
change without its neighbours moving is not a nicety here — it is how a price is read.

## Space, radius, elevation, motion, depth

- **Space**, 4px base: `--space-1` .25rem, `-2` .5, `-3` .75, `-4` 1, `-5` 1.25, `-6` 1.5, `-8` 2,
  `-10` 2.5, `-12` 3rem.
- **Radius**: `--radius-sm` 6px (chips inside dense rows), `--radius-md` 10px (controls, inputs,
  tiles — aliased as `--radius` for existing rules), `--radius-lg` 14px (cards), `--radius-pill`
  999px (badges, the fee chip).
- **Elevation**: `--shadow-1` resting card (aliased as `--shadow`), `--shadow-2` tooltip and chart
  tip, `--shadow-3` overlay. Shadow colour comes from `--ink-dark` / `--ink-light` channels.
- **Motion**: `--duration-fast` 120ms for hover and colour changes, `--duration-base` 200ms,
  `--duration-slow` 320ms, on `--ease-out` or `--ease-in-out`. Under `prefers-reduced-motion` every
  transition and animation collapses to 1ms and the skeleton shimmer stops.
- **Depth**: `--z-base` 0, `--z-sticky` 10 (top bar), `--z-overlay` 100, `--z-tooltip` 200.
- **Layout**: `--container` 1080px.

## Themes

```css
:root                                              { /* dark tokens */ }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"])                   { /* light tokens */ }
}
:root[data-theme="light"]                          { /* light tokens */ }
```

Dark is the base, so a viewer expressing no preference gets dark. A light system preference gets
light. An explicit `data-theme` on the document element wins over both — the `:not()` guard is what
makes forcing dark possible. `color-scheme` is set in both branches so form controls and scrollbars
follow.

Today only `/design` writes `data-theme`. A user-facing theme switch in the top bar would reuse
the same mechanism.

## Portfolio components

Three additions made for the Portfolio, all built from existing semantic tokens.

- **`.stats` / `.stat`** — the summary strip. Label in `--text-2xs` uppercase muted, value in the
  display face at `--text-lg` with tabular figures, optional muted sub-line. Values stay in
  `--text`: money you can claim is not a YES outcome, and colouring it green would break the
  colour law. The call to action is the redeem button, not the number.
- **`.count`** — a pill riding inside a tab or filter button. It inverts on a filled or active
  parent so the count stays legible on the accent.
- **`.fill`** — a 3px progress meter for how far an order has filled. Decorative: the
  `filled / total` figures printed above it are authoritative, and the meter carries a `title`.

Position and order lifecycle states reuse the existing badge kinds rather than adding new ones,
which keeps state colour consistent with the rest of the app:

| State | Badge kind | Meaning |
| --- | --- | --- |
| Open | `open` | Market still trading, or order still fillable |
| Awaiting result | `warn` | Trading closed, resolver has not submitted a result |
| Redeemable | `resolved` | Resolved in the holder's favour, collateral claimable |
| No payout | `closed` | Resolved against this holding |
| Filled | `resolved` | Order completely filled |
| Closed | `closed` | Order cancelled, or its market closed |

## Live notices

The creator's notices (`web/src/components/Toasts.tsx`, fed by `LiveNotices.tsx`) are a stack
fixed at the bottom-right corner, `--z-overlay`, 23rem wide and full-width under 700px. Built
from existing tokens; the only new rules are `.toasts` and `.toast-*`.

- **Words.** The headline is the thing — the question, or the event's title — in the display face
  at `--text-md`, clamped to two lines. The eyebrow above it is what happened: `MARKET CREATED`,
  `EVENT CREATED · 8 MARKETS`. It says *created* and never *tradable*, since whether a market can
  trade is decided by executable liquidity, not by this notice. The meta line carries the block
  and the transaction, so the claim is checkable from the card.
- **Colour.** Green eyebrow and dot: success, which is what green means in a notice. Amber with a
  muted `confirming`: only the chain stream has vouched for it so far; the worker's receipt has not
  arrived, and a reorg could still withdraw it. Nothing here is an outcome, so nothing here is
  red or green in the outcome sense.
- **Stack.** Newest in front. Behind it, up to two more peek out by 12px at 5% steps of scale;
  hover, focus, or a tap fans them out with a 10px gap and a "Dismiss all" row. Every card is
  positioned by `transform` from measured heights, so the fan-out is one interruptible
  `--duration-slow` transition on `--ease-out`.
- **Motion.** A card enters from below the edge; it leaves the same way, faster (220ms), and the
  cards behind close the gap. A notice that arrived while the tab was open rings its dot three
  times; one found on load does not. Swiping a card down dismisses it — past 48px, or any flick
  faster than 0.11px/ms — with friction when dragged the wrong way. Buttons scale to .96 on press.
  Reduced motion collapses all of it, via the global rule.
- **Persistence.** Nothing times out. Opening a notice or dismissing it marks it read on the
  server; the portfolio still lists the market.

## Curve editor components

The curve editor is one component reused by the trade ticket's **Curve** tab and by the `/curves`
explainer. It is deliberately free of wallet, market and API access, which is what lets the
explainer render outside the API config gate the way `/design` does.

- **`CurveChart`** — one chart, two modes. Without `onChange` it is a read-only picture and its
  `<svg>` keeps `role="img"`. With `onChange` it becomes an editor: `role` changes to `group` so
  the controls inside it are reachable, the two endpoints become `role="slider"` handles, and the
  dashed shapes it already drew become clickable switches. `caption={false}` drops the built-in
  sentence where several charts sit together and would otherwise repeat it verbatim.
- **`.chart-handle` / `.chart-hit`** — the visible 4-unit dot and the 11-unit invisible target
  behind it. Only the hit shapes take pointer events; the crosshair, gridlines and labels are
  explicitly `pointer-events: none`, because the crosshair tracks the pointer and would otherwise
  swallow every press aimed at the handle it is sitting on.
- **`.chart-summary`** — one line, rules-marked with an accent border, replacing the four
  runtime-generated prose notices this flow used to carry. The figures are rounded for scanning;
  the `.chart-readout` under it carries the exact ones.
- **`.shape-pick`** — the shape control. Three `.seg` buttons in a `radiogroup`, each drawing its
  own price path from `priceAt` and annotated with the exponent the contract uses. It replaces a
  `<select>`, which hid two of the three options and described a curve in words.

Shape names are behaviour-first — **Even** (α1), **Patient** (α2), **Very patient** (α3). The
exponent stays visible as a mono annotation because it is what the API, the subgraph and
`CurveMath.sol` call it. These names are also used by the Portfolio order table; change them in
both places or an order will be labelled one way where it is made and another where it is listed.

Two rules the editor depends on:

1. **The axis is frozen while a handle is being dragged.** It is otherwise derived from the very
   price being dragged, so the plot would move under the pointer. One gesture therefore reaches
   only as far as the band on screen; the keyboard and the number fields have the full range.
2. **Dragging clamps, it never errors.** A buy curve's end cannot pass its start and a sell
   curve's cannot fall below it, so a gesture always yields a publishable order. The only
   reachable price errors come from typing, which is why they appear on blur.

## Adding a component

1. Check whether an existing class already carries the pattern. Reuse beats addition.
2. Write the rule in the component layer, at the bottom, under a comment naming the component.
3. Consume semantic tokens only. If you reach for a raw colour, the semantic layer is missing a
   token — add it to **both** themes rather than hardcoding.
4. Use scale tokens for size, space, radius, and duration. A literal `px` in a component rule
   should be rare and deliberate.
5. Bound a control with `--border-strong`, a decorative region with `--border`.
6. If it carries state, pair colour with a second cue — a label, an icon, or position.
7. Add it to `web/src/pages/DesignSystem.tsx` in every state it can occupy. A component absent from
   `/design` is a component nobody will notice breaking.

## Decisions and alternatives

Each of these is one token away from being changed.

- **Display typeface: Space Grotesk.** Geometric with strong figures; reads technical without
  reading like a template. The alternative was Inter Tight for a quieter, more neutral product —
  swap `--font-display`. Body face Inter and mono JetBrains Mono are the conservative choices and
  were not seriously contested.
- **Dark as the default.** An exchange reads as a trading product in dark, and the navy→cyan brand
  only sings against a dark ground. The alternative — keeping light as the default and offering
  dark — would mean the brand accent almost never appears at full strength. Swap by moving the
  light block into bare `:root` and inverting the media query.
- **Shell ground `#02102A`, a near-black navy.** The alternative was the brand navy `#031B47`
  itself, which is lighter and warmer but leaves less room to separate `--surface` from `--bg` —
  swap `--bg`.
- **Light-theme accent is the brand mid blue, not cyan.** Forced by contrast, not taste: cyan
  cannot carry text or a filled control on white. Deep cyan `--cyan-700` carries the brand role
  there instead.
- **Aqua for product claims in dark.** Without this, `--brand` and `--accent` were both cyan-400
  and the zero-fee notice was indistinguishable from an informational one. Swap `--brand` if the
  separation is ever unwanted.
- **Price at `--text-2xl` (32px).** Deliberately louder than the `h1` above it, because on a market
  card the price is the headline and the question is the label. Step it down at `--text-xl` if the
  cards ever feel shouty.
