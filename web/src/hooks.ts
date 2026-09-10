import { useCallback, useEffect, useState } from 'react';

/**
 * The API serves index.html for browser routes, so the app can use ordinary clean URLs.
 *
 * `query` is rebuilt on every render, so it is safe to read during render or in a handler but must
 * never appear in a `useAsync` dependency array — it would never compare equal and would refetch
 * forever. Read the parameters that matter into state instead.
 */
export function useRoute(): { path: string[]; query: URLSearchParams; location: string } {
  const read = () => `${window.location.pathname}${window.location.search}` || '/';
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const [pathname = '/', search = ''] = location.split('?');
  return { location, path: pathname.split('/').filter(Boolean), query: new URLSearchParams(search) };
}

/**
 * A redirect has to replace its history entry rather than add one, or Back returns to the address
 * that redirected and is sent forward again — a page the user cannot escape backwards.
 * History updates do not raise `popstate`, so the router is told directly.
 */
export const navigate = (to: string, options?: { replace?: boolean }) => {
  window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

export type Async<T> = { data?: T; error?: unknown; loading: boolean; reload: () => void };

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  useEffect(() => {
    let cancelled = false;
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    run().then(
      data => { if (!cancelled) setState({ data, loading: false }); },
      error => { if (!cancelled) setState({ error, loading: false }); },
    );
    return () => { cancelled = true; };
  }, [run, tick]);
  return { ...state, reload: () => setTick(value => value + 1) };
}

/** Creation request tokens are held per browser only; the server stores a hash of them. */
export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const stored = window.localStorage.getItem(key); return stored ? JSON.parse(stored) as T : initial; }
    catch { return initial; }
  });
  const update = useCallback((next: T) => {
    setValue(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
  }, [key]);
  return [value, update];
}
