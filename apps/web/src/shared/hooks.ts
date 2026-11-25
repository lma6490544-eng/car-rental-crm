import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
const scrollPositions = new Map<string, number>();
export function useListScroll(key: string, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    window.scrollTo(0, scrollPositions.get(key) ?? 0);
    const save = () => scrollPositions.set(key, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => window.removeEventListener('scroll', save);
  }, [key, ready]);
}
export function usePolling<T>(path: string | undefined, keepPreviousData = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [settledPath, setSettledPath] = useState<string>();
  const [loading, setLoading] = useState(true);
  const trigger = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    let inFlight: Promise<void> | undefined;
    let queued: Promise<void> | undefined;
    if (!keepPreviousData) setData(undefined);
    setLoading(true);
    setError('');
    if (path === undefined) {
      trigger.current = async () => {};
      setLoading(false);
      return;
    }
    const load = (): Promise<void> => {
      if (!alive || !navigator.onLine || document.visibilityState === 'hidden')
        return Promise.resolve();
      if (inFlight) {
        queued ??= inFlight.then(() => {
          queued = undefined;
          return load();
        });
        return queued;
      }
      inFlight = api<T>(path)
        .then((value) => {
          if (alive) {
            setData(value);
            setError('');
          }
        })
        .catch((failure: unknown) => {
          if (alive) setError(errorMessage(failure));
        })
        .finally(() => {
          inFlight = undefined;
          if (alive) {
            setLoading(false);
            setSettledPath(path);
          }
        });
      return inFlight;
    };
    trigger.current = load;
    const refresh = () => {
      void load();
    };
    const timer = window.setInterval(() => {
      if (!inFlight) void load();
    }, 5000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    void load();
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [path, keepPreviousData]);
  return {
    data,
    error,
    loading: path !== undefined && (loading || settledPath !== path),
    reload: useCallback(() => trigger.current(), []),
  };
}
