import { useCallback, useEffect, useState } from 'react';

/** Hash routing keeps the built frontend deployable as static files behind the API. */
export function useRoute(): { path: string[]; query: URLSearchParams; hash: string } {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const update = () => setHash(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [pathname = '/', search = ''] = hash.split('?');
  return { hash, path: pathname.split('/').filter(Boolean), query: new URLSearchParams(search) };
}

export const navigate = (to: string) => { window.location.hash = to; };

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
