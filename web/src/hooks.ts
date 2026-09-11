import { useCallback, useEffect, useRef, useState } from 'react';
import { live, type LiveEvent } from './live';

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

/**
 * Live messages, for the page that cares. The handler always sees the latest render's closure,
 * and the subscription is made once, so a page neither misses a message nor re-subscribes on
 * every state change. Pages refresh the one piece a message concerns; nothing reloads wholesale.
 */
export function useLive(handler: (event: LiveEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => live.subscribe(event => latest.current(event)), []);
}

/** Whether the tab currently holds a live connection, for a small indicator. */
export function useLiveStatus(): boolean {
  const [connected, setConnected] = useState(live.connected);
  useEffect(() => live.onStatus(setConnected), []);
  return connected;
}

/** A reload that collapses a burst of messages into one request. */
export function useDebouncedReload(reload: () => void, ms = 400) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => latest.current(), ms);
  }, [ms]);
}
