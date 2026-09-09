import { createContext, useContext, useEffect, useState } from 'react';
import { api, type AppConfig } from './api';
import { useAsync, useRoute } from './hooks';
import { ErrorBox, Loading, Logo, Notice } from './components/Ui';
import { currentAccount, connect, describeWalletError, walletAvailable } from './wallet';
import { Markets } from './pages/Markets';
import { MarketDetail } from './pages/MarketDetail';
import { Holdings } from './pages/Holdings';
import { PublishCurve } from './pages/PublishCurve';
import { CreateMarket } from './pages/CreateMarket';
import { Admin } from './pages/Admin';

type Wallet = { account?: string; connect: () => Promise<void>; error?: string };
const ConfigContext = createContext<AppConfig | undefined>(undefined);
const WalletContext = createContext<Wallet>({ connect: async () => undefined });
export const useConfig = () => useContext(ConfigContext)!;
export const useWallet = () => useContext(WalletContext);

// The operator screen is deliberately absent from the navigation; it is reached by its path.
const LINKS = [['/', 'Markets'], ['/holdings', 'Portfolio'], ['/publish', 'Pricing curves'], ['/create', 'Create market']] as const;

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
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Horizon home"><Logo /></a>
        <nav className="nav">
          {LINKS.map(([href, label]) => (
            <a key={href} href={`#${href}`} aria-current={active === href || (href !== '/' && active.startsWith(href)) ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <span className="zero-fee">0% trading fees</span>
        {walletAvailable()
          ? <button className={account ? '' : 'primary'} onClick={() => void wallet.connect()}>
              {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'Connect wallet'}
            </button>
          : <span className="small muted">No browser wallet detected</span>}
      </header>
      <main>
        {walletError && <div style={{ marginBottom: '1rem' }}><Notice kind="warn">{walletError}</Notice></div>}
        {config.loading && <Loading rows={4} label="Loading Horizon configuration" />}
        {config.error ? <ErrorBox error={config.error} retry={config.reload} /> : null}
        {config.data && (
          <ConfigContext.Provider value={config.data}>
            <WalletContext.Provider value={wallet}>
              <Page route={route} />
            </WalletContext.Provider>
          </ConfigContext.Provider>
        )}
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
  if (section === 'markets' && parameter) return <MarketDetail market={parameter} />;
  if (section === 'holdings') return <Holdings />;
  if (section === 'publish') return <PublishCurve query={route.query} />;
  if (section === 'create') return <CreateMarket />;
  if (section === 'admin') return <Admin />;
  return <Notice kind="warn">That page does not exist. <a href="#/">Back to markets</a>.</Notice>;
}
