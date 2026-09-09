import { useEffect, useState } from 'react';
import { CurveChart } from '../components/CurveChart';
import { OrderBook } from '../components/OrderBook';
import {
  Address, Badge, Card, Empty, Loading, Logo, Notice, TransactionState, TxLink, ZeroFee,
} from '../components/Ui';
import type { OutcomeBook } from '../api';
import type { CurvePreview } from '../curve';

/**
 * The living design system. Reached at `#/design` and deliberately absent from the
 * navigation, like the operator screen. It renders the real components rather than
 * copies of them, so anything that drifts from the tokens shows up here first.
 *
 * Themes: dark is the default, light is the alternate. The switch writes
 * `data-theme` on the document element, which is what `styles.css` reads.
 */

type Theme = 'system' | 'dark' | 'light';

const SEMANTIC: [string, string[]][] = [
  ['Ground', ['--bg', '--surface', '--surface-2', '--surface-3', '--border', '--border-strong']],
  ['Text', ['--text', '--muted']],
  ['Accent — interaction', ['--accent', '--accent-soft', '--accent-border', '--on-accent']],
  ['Brand — product claims, never green', ['--brand', '--brand-soft', '--brand-border', '--on-brand']],
  ['YES / buy — and notice success', ['--yes', '--yes-soft', '--yes-border', '--on-yes']],
  ['NO / sell — and notice failure', ['--no', '--no-soft', '--no-border', '--on-no']],
  ['Caution — never an outcome', ['--warn', '--warn-soft', '--warn-border', '--on-warn']],
];

const PRIMITIVES: [string, string[]][] = [
  ['Navy', ['--navy-25', '--navy-50', '--navy-100', '--navy-200', '--navy-300', '--navy-400', '--navy-500', '--navy-600', '--navy-700', '--navy-800', '--navy-900', '--navy-950']],
  ['Navy — dark-theme ground', ['--navy-ink', '--navy-ink-muted', '--navy-rule', '--navy-surface-high', '--navy-surface-raised', '--navy-surface']],
  ['Cyan', ['--cyan-25', '--cyan-50', '--cyan-100', '--cyan-200', '--cyan-300', '--cyan-400', '--cyan-500', '--cyan-600', '--cyan-700', '--cyan-800', '--cyan-900']],
  ['Green', ['--green-100', '--green-300', '--green-500', '--green-600', '--green-900']],
  ['Red', ['--red-100', '--red-300', '--red-500', '--red-600', '--red-900']],
  ['Amber', ['--amber-100', '--amber-300', '--amber-600', '--amber-900']],
  ['Neutral', ['--neutral-0', '--neutral-50', '--neutral-100', '--neutral-150', '--neutral-200', '--neutral-400', '--neutral-600', '--neutral-900']],
];

const TYPE: [string, string][] = [
  ['--text-3xl', 'Hero figure'],
  ['--text-2xl', 'Price 62.50%'],
  ['--text-xl', 'Page heading'],
  ['--text-lg', 'Section heading'],
  ['--text-md', 'Card heading'],
  ['--text-base', 'Body copy at fifteen pixels'],
  ['--text-sm', 'Secondary row, ladder'],
  ['--text-xs', 'Badge, table header, hint'],
  ['--text-2xs', 'Axis tick, chart unit'],
];

const SPACE = ['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-8', '--space-10', '--space-12'];
const RADIUS = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-pill'];
const SHADOW = ['--shadow-1', '--shadow-2', '--shadow-3'];

const BOOK: OutcomeBook = {
  // Asks ascend and bids descend, so the ladder renders best-ask nearest the spread.
  asks: [
    { price: 595000, shares: '4200000', orders: 2, source: 'direct', executable: true },
    { price: 610000, shares: '9100000', orders: 1, source: 'complementary', executable: true },
    { price: 640000, shares: '2500000', orders: 1, source: 'mixed', executable: false },
  ],
  bids: [
    { price: 570000, shares: '7300000', orders: 3, source: 'direct', executable: true },
    { price: 540000, shares: '12000000', orders: 1, source: 'complementary', executable: true },
  ],
  spread: 25000,
};

const CURVE: CurvePreview = { isBuy: true, startPrice: 620000, endPrice: 430000, shape: 2, shares: 25_000_000n };

export function DesignSystem() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    return () => root.removeAttribute('data-theme');
  }, [theme]);

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h1>Design system</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Every token and every component, rendered from the real code. Dark is the default;
            light is the alternate. Written reference: <code>docs/DESIGN_SYSTEM.md</code>.
          </p>
        </div>
        <div className="seg" style={{ marginBottom: 0, minWidth: '15rem' }}>
          {(['system', 'dark', 'light'] as const).map(option => (
            <button key={option} className={theme === option ? 'active' : ''} onClick={() => setTheme(option)}>
              {option.charAt(0).toUpperCase()}{option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <section className="ds-section">
        <h2>Semantic colour</h2>
        <p className="small muted">
          What a colour is <em>for</em>. Components read only these. The rule is strict: in data and
          controls green is YES and buy and red is NO and sell, exclusively; in notices green is
          success and red is failure; cyan is interaction, aqua is a product claim, amber is
          caution. A product claim is never green.
        </p>
        {SEMANTIC.map(([group, tokens]) => (
          <div key={group} style={{ marginBottom: 'var(--space-4)' }}>
            <h3>{group}</h3>
            <Swatches tokens={tokens} />
          </div>
        ))}
      </section>

      <section className="ds-section">
        <h2>Primitive ramps</h2>
        <p className="small muted">Raw brand values with no meaning attached. Never referenced by a component.</p>
        {PRIMITIVES.map(([group, tokens]) => (
          <div key={group} style={{ marginBottom: 'var(--space-4)' }}>
            <h3>{group}</h3>
            <Swatches tokens={tokens} />
          </div>
        ))}
      </section>

      <section className="ds-section">
        <h2>Type</h2>
        <p className="small muted">
          Space Grotesk sets headings and figures, Inter carries UI text, JetBrains Mono gives the
          ladder and addresses true tabular figures.
        </p>
        <div className="ds-scale">
          {TYPE.map(([token, sample]) => (
            <div key={token}>
              <code className="mono small">{token}</code>
              <span style={{ fontSize: `var(${token})`, fontFamily: token === '--text-2xl' || token === '--text-3xl' ? 'var(--font-display)' : undefined }}>{sample}</span>
            </div>
          ))}
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Families</h3>
        <div className="ds-specimen">
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)' }}>Space Grotesk 0123456789</span>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)' }}>Inter 0123456789</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)' }}>JetBrains Mono 0123456789</span>
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Tabular figures</h3>
        <p className="small muted">Both columns hold the same values. Only the second aligns.</p>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-8)' }}>
          <div style={{ fontVariantNumeric: 'normal' }}>{['0.6400', '0.1111', '0.9876'].map(v => <div key={v}>{v} USDC</div>)}</div>
          <div className="tnum">{['0.6400', '0.1111', '0.9876'].map(v => <div key={v}>{v} USDC</div>)}</div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Space, radius, elevation, motion</h2>
        <div className="ds-scale">
          {SPACE.map(token => (
            <div key={token}>
              <code className="mono small">{token}</code>
              <span className="ds-ruler" style={{ width: `var(${token})` }} />
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          {RADIUS.map(token => (
            <div key={token} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: `var(${token})`, padding: 'var(--space-3) var(--space-4)' }}>
              <code className="mono small">{token}</code>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          {SHADOW.map(token => (
            <div key={token} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: `var(${token})`, padding: 'var(--space-4)' }}>
              <code className="mono small">{token}</code>
            </div>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 'var(--space-3)' }}>
          Motion: <code>--duration-fast</code> 120ms, <code>--duration-base</code> 200ms,
          <code> --duration-slow</code> 320ms, on <code>--ease-out</code>. All of it collapses to
          1ms under <code>prefers-reduced-motion</code>.
        </p>
      </section>

      <section className="ds-section">
        <h2>Brand</h2>
        <div className="row" style={{ gap: 'var(--space-6)' }}>
          <Logo />
          <Logo size={44} wordmark={false} />
          <span className="zero-fee">0% trading fees</span>
        </div>
      </section>

      <section className="ds-section">
        <h2>Buttons</h2>
        <div className="row">
          <button>Default</button>
          <button className="primary">Primary</button>
          <button className="yes">Buy YES</button>
          <button className="no">Sell NO</button>
          <button className="link">Link button</button>
          <button disabled>Disabled</button>
        </div>
        <div style={{ maxWidth: '20rem', marginTop: 'var(--space-3)' }}>
          <button className="primary wide">Wide — review order</button>
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Segmented controls</h3>
        <div style={{ maxWidth: '24rem' }}>
          <div className="seg tabs">
            <button className="active">Market</button>
            <button>Limit</button>
          </div>
          <div className="seg">
            <button className="yes">Buy</button>
            <button>Sell</button>
          </div>
          <div className="seg">
            <button className="active">YES</button>
            <button>NO</button>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Badges and steps</h2>
        <div className="row">
          <Badge kind="open">OPEN</Badge>
          <Badge kind="closed">CLOSED</Badge>
          <Badge kind="resolved">Resolved YES</Badge>
          <Badge kind="warn">Awaiting payment</Badge>
          <Badge kind="no">Resolved NO</Badge>
        </div>
        <div className="steps" style={{ marginTop: 'var(--space-3)' }}>
          <span className="done">Draft</span>
          <span className="done">Review</span>
          <span className="active">Verify</span>
          <span>Pay</span>
          <span>Create</span>
        </div>
      </section>

      <section className="ds-section">
        <h2>Notices</h2>
        <div className="stack">
          <Notice kind="info">Confirm the request in your wallet…</Notice>
          <Notice kind="ok">Confirmed on Sepolia.</Notice>
          <Notice kind="warn">The last payment result was ambiguous. An operator must reconcile it.</Notice>
          <Notice kind="error">The facilitator rejected the payment authorization.</Notice>
          <Notice kind="brand">A product claim, not an outcome. Green is reserved for YES.</Notice>
          <ZeroFee />
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Transaction state</h3>
        <div className="stack">
          <TransactionState state={{ phase: 'signing' }} />
          <TransactionState state={{ phase: 'pending', hash: '0x465d78fa22ade4503a1693993f947379ecbb6d5601262de284144938a44b7860' }} />
          <TransactionState state={{ phase: 'confirmed', hash: '0x465d78fa22ade4503a1693993f947379ecbb6d5601262de284144938a44b7860' }} />
          <TransactionState state={{ phase: 'error', message: 'The transaction failed.' }} />
        </div>
      </section>

      <section className="ds-section">
        <h2>Price tiles</h2>
        <p className="small muted">The loudest element on a market card. Colour is the outcome; size is the hierarchy.</p>
        <div style={{ maxWidth: '26rem' }}>
          <div className="prices">
            <div className="price-tile yes">
              <div className="label">Buy YES</div>
              <div className="value">62.50%</div>
              <div className="small muted">4.20 shares available</div>
            </div>
            <div className="price-tile no">
              <div className="label">Buy NO</div>
              <div className="value">37.50%</div>
              <div className="small muted">9.10 shares available</div>
            </div>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Portfolio</h2>
        <p className="small muted">
          Summary tiles, the counted tabs and filters, the fill meter, and every lifecycle state a
          position or an order can be in.
        </p>
        <div className="stats">
          <div className="stat"><div className="label">Redeemable now</div><div className="value">2.500000 USDC</div><div className="small muted">1 resolved market</div></div>
          <div className="stat"><div className="label">Positions</div><div className="value">4</div><div className="small muted">1 awaiting a result</div></div>
          <div className="stat"><div className="label">Open orders</div><div className="value">3</div><div className="small muted">1 partly filled</div></div>
          <div className="stat"><div className="label">Posted in open buys</div><div className="value">13.920000 USDC</div><div className="small muted">across 2 orders</div></div>
        </div>
        <div className="seg tabs" style={{ marginTop: 'var(--space-4)', maxWidth: '24rem' }}>
          <button className="active">Positions <span className="count">4</span></button>
          <button>Orders <span className="count">3</span></button>
        </div>
        <div className="row">
          <button className="primary">All <span className="count">4</span></button>
          <button>Open <span className="count">2</span></button>
          <button>Awaiting result <span className="count">1</span></button>
          <button>Redeemable <span className="count">1</span></button>
          <button>No payout <span className="count">0</span></button>
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Position states</h3>
        <div className="row">
          <Badge kind="open">Open</Badge>
          <Badge kind="warn">Awaiting result</Badge>
          <Badge kind="resolved">Redeemable · YES</Badge>
          <Badge kind="closed">No payout · NO</Badge>
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Order states and fill</h3>
        <div className="row" style={{ marginBottom: 'var(--space-3)' }}>
          <Badge kind="open">Open</Badge>
          <Badge kind="resolved">Filled</Badge>
          <Badge kind="closed">Closed</Badge>
        </div>
        <div style={{ maxWidth: '18rem' }}>
          {[0, 35, 100].map(percent => (
            <div key={percent} className="small" style={{ marginBottom: 'var(--space-2)' }}>
              {percent}% filled
              <div className="fill"><span style={{ width: `${percent}%` }} /></div>
            </div>
          ))}
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Your own resting order</h3>
        <p className="small muted">Shown beside the book on a market page, narrow enough for the side column.</p>
        <div style={{ maxWidth: '22rem' }}>
          <div className="own-order">
            <div className="row between">
              <span className="badge resolved">BUY YES</span>
              <span className="mono small">0.6200 USDC → 0.4300 USDC</span>
            </div>
            <div className="fill"><span style={{ width: '35%' }} /></div>
            <div className="row between small muted">
              <span>8.750000 / 25.000000 filled</span>
              <button className="link">Cancel</button>
            </div>
          </div>
          <div className="own-order">
            <div className="row between">
              <span className="badge no">SELL NO</span>
              <span className="mono small">0.4000 USDC</span>
            </div>
            <div className="fill"><span style={{ width: '0%' }} /></div>
            <div className="row between small muted">
              <span>0 / 1.000000 filled</span>
              <button className="link">Cancel</button>
            </div>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Order book</h2>
        <div className="split">
          <Card title="Ladder · YES">
            <OrderBook book={BOOK} isYes />
          </Card>
          <Card title="Order summary">
            <dl className="kv total">
              <dt>Shares</dt><dd>4.000000</dd>
              <dt>You pay</dt><dd>2.560000 USDC</dd>
              <dt>Average price</dt><dd>0.6400 USDC</dd>
              <dt>Fees</dt><dd>0.000000 USDC</dd>
            </dl>
          </Card>
        </div>
      </section>

      <section className="ds-section">
        <h2>Curve chart</h2>
        <div style={{ maxWidth: '30rem' }}>
          <CurveChart curve={CURVE} size={CURVE.shares} />
          <div className="chart-readout">
            <div><div className="label">Start</div><div className="value">0.6200</div></div>
            <div><div className="label">End</div><div className="value">0.4300</div></div>
            <div><div className="label">Average</div><div className="value">0.5567</div></div>
            <div><div className="label">Posts</div><div className="value">13.92</div></div>
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Forms</h2>
        <div style={{ maxWidth: '30rem' }}>
          <div className="fields">
            <div className="field">
              <label htmlFor="ds-start">Start price</label>
              <input id="ds-start" defaultValue="0.62" />
              <div className="hint">USDC per share, six decimals.</div>
            </div>
            <div className="field">
              <label htmlFor="ds-end">End price</label>
              <input id="ds-end" defaultValue="1.40" aria-invalid="true" />
              <div className="error">A price cannot exceed 1 USDC.</div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="ds-shape">Shape</label>
            <select id="ds-shape" defaultValue="2"><option value="1">α1 — linear</option><option value="2">α2</option><option value="3">α3</option></select>
          </div>
          <div className="field">
            <label htmlFor="ds-rules">Resolution rules</label>
            <textarea id="ds-rules" defaultValue="Resolves YES if the reference source reports the event before the close time." />
          </div>
        </div>
      </section>

      <section className="ds-section">
        <h2>Data</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Market</th><th>Outcome</th><th>Filled</th><th>Collateral</th></tr></thead>
            <tbody>
              <tr><td>Will the bill pass by June?</td><td>YES</td><td>4.000000</td><td>2.560000 USDC</td></tr>
              <tr><td>Will the index close above 5,000?</td><td>NO</td><td>12.500000</td><td>7.812500 USDC</td></tr>
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: 'var(--space-4)' }}>Key/value</h3>
        <dl className="kv">
          <dt>Registry</dt><dd><Address value="0xa1151c78bf5ba0ce80b1f78626c4c0f2c7d131a1" /></dd>
          <dt>Creation tx</dt><dd><TxLink hash="0x465d78fa22ade4503a1693993f947379ecbb6d5601262de284144938a44b7860" /></dd>
          <dt>Indexed block</dt><dd className="mono">11667798</dd>
        </dl>
      </section>

      <section className="ds-section">
        <h2>Loading and empty</h2>
        <Card title="Loading"><Loading rows={3} label="Loading markets" /></Card>
        <Card title="Empty">
          <Empty title="No markets are indexed yet"><p>Create the first one from the <a href="#/create">Create market</a> page.</p></Empty>
        </Card>
      </section>
    </div>
  );
}

function Swatches({ tokens }: { tokens: string[] }) {
  return (
    <div className="ds-swatches">
      {tokens.map(token => (
        <div key={token} className="ds-swatch">
          <div className="chip" style={{ background: `var(${token})` }} />
          <code className="name">{token}</code>
        </div>
      ))}
    </div>
  );
}
