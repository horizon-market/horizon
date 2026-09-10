import { createContext, useContext, useEffect, useState } from 'react';
import { api, type AppConfig } from './api';
import { navigate, useAsync, useRoute } from './hooks';
import { ErrorBox, HelpLink, Loading, Logo, Notice } from './components/Ui';
import { currentAccount, connect, describeWalletError, walletAvailable } from './wallet';
import { Markets } from './pages/Markets';
import { MarketDetail } from './pages/MarketDetail';
import { EventDetail } from './pages/EventDetail';
import { Holdings } from './pages/Holdings';
import { Curves } from './pages/Curves';
import { CreateMarket } from './pages/CreateMarket';
import { Admin } from './pages/Admin';
import { DesignSystem } from './pages/DesignSystem';

type Wallet = { account?: string; connect: () => Promise<void>; error?: string };
const ConfigContext = createContext<AppConfig | undefined>(undefined);
const WalletContext = createContext<Wallet>({ connect: async () => undefined });
export const useConfig = () => useContext(ConfigContext)!;
export const useWallet = () => useContext(WalletContext);

// Discovery and creation on the left; what belongs to this account on the right, beside the wallet
// it belongs to. Publishing a curve is not here: it needs a market in front of it, so it lives in
// that market's trade ticket. The curve explainer follows the sections as a help link rather than a
// third one — curves are what this exchange does differently, and the page that says so was
// unreachable without scrolling past a market to the footer. The operator screen and the
// design-system reference stay absent; both are reached by their path.
const LINKS = [['/', 'Markets'], ['/create', 'Create market']] as const;
const PERSONAL = ['/holdings', 'Portfolio'] as const;
// Pages that render from tokens and pure arithmetic, so they stay reviewable without an API.
const STANDALONE = new Set(['design', 'curves']);

export function App() {
  const route = useRoute();
  const config = useAsync(() => api.config(), []);
  const [account, setAccount] = useState<string | undefined>();
  const [walletError, setWalletError] = useState<string | undefined>();
  useEffect(() => { currentAccount().then(setAccount).catch(() => undefined); }, []);
  const wallet: Wallet = {
    account, error: walletError,
    connect: async () => {
      setWalletError(undefined);
      try { setAccount(await connect()); }
      catch (error) { setWalletError(describeWalletError(error)); }
    },
  };
  const active = `/${route.path.join('/')}`;
  const standalone = STANDALONE.has(route.path[0] ?? '');
  const link = ([href, label]: readonly [string, string]) => (
    <a key={href} href={href}
      aria-current={active === href || (href !== '/' && active.startsWith(href)) ? 'page' : undefined}>{label}</a>
  );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Horizon home"><Logo /></a>
        <nav className="nav">
          {LINKS.map(link)}
          <HelpLink href="/curves" current={active === '/curves'}>How curves work</HelpLink>
        </nav>
        {/* Everything that belongs to this account sits together, next to the wallet it belongs to. */}
        <div className="nav-end">
          <span className="zero-fee">0% trading fees</span>
          <nav className="nav">{link(PERSONAL)}</nav>
          {walletAvailable()
            ? <button className={account ? '' : 'primary'} onClick={() => void wallet.connect()}>
                {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'Connect wallet'}
              </button>
            : <span className="small muted">No browser wallet detected</span>}
        </div>
      </header>
      <main>
        {walletError && <div style={{ marginBottom: '1rem' }}><Notice kind="warn">{walletError}</Notice></div>}
        {standalone
          ? <Page route={route} />
          : <>
              {config.loading && <Loading rows={4} label="Loading Horizon configuration" />}
              {config.error ? <ErrorBox error={config.error} retry={config.reload} /> : null}
              {config.data && (
                <ConfigContext.Provider value={config.data}>
                  <WalletContext.Provider value={wallet}>
                    <Page route={route} />
                  </WalletContext.Provider>
                </ConfigContext.Provider>
              )}
            </>}
      </main>
      <footer>
        Horizon settles on Ethereum Sepolia with test USDC. Markets are resolved by a disclosed centralized resolver;
        INVALID pays 0.5 USDC per outcome token. Zero trading fees; market creation is a separate paid service.
      </footer>
    </div>
  );
}

function Page({ route }: { route: ReturnType<typeof useRoute> }) {
  const [section, parameter] = route.path;
  if (!section) return <Markets />;
  // Keyed on the address: the component sits at a fixed position, so without this, moving from one
  // market to another would keep the previous market's outcome, ticket tab and half-written order.
  if (section === 'markets' && parameter) return <MarketDetail key={parameter} market={parameter} query={route.query} />;
  // An event has its own address; a child market keeps the address it always had.
  if (section === 'events' && parameter) return <EventDetail key={parameter} slug={parameter} />;
  if (section === 'holdings') return <Holdings query={route.query} />;
  if (section === 'curves') return <Curves />;
  // Curves are published from the market they belong to now, so the old standalone address forwards
  // into that market's ticket rather than dying.
  if (section === 'publish') return <Redirect to={publishTarget(route.query)} />;
  if (section === 'create') return <CreateMarket />;
  if (section === 'operator') return <Admin />;
  if (section === 'design') return <DesignSystem />;
  return <Notice kind="warn">That page does not exist. <a href="/">Back to markets</a>.</Notice>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Where a link to the retired publish page should have gone. */
function publishTarget(query: URLSearchParams): string {
  const market = query.get('market');
  if (!market || !ADDRESS.test(market)) return '/';
  const params = new URLSearchParams({ ticket: query.get('type') === 'limit' ? 'limit' : 'curve' });
  for (const key of ['side', 'direction'] as const) {
    const value = query.get(key);
    if (value) params.set(key, value);
  }
  return `/markets/${market}?${params}`;
}

/**
 * Navigating from an effect rather than during render, and replacing the history entry rather than
 * adding one: a pushed entry would send Back to this address, which would forward again.
 */
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return <Loading rows={2} label="Redirecting" />;
}
