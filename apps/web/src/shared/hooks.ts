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
export function usePolling<T>(path: string, keepPreviousData = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [settledPath, setSettledPath] = useState<string>();
  const [loading, setLoading] = useState(true);
  const trigger = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true,
      busy = false,
      again = false;
    if (!keepPreviousData) setData(undefined);
    setLoading(true);
    setError('');
    const load = async () => {
      if (!alive) return;
      if (busy) {
        again = true;
        return;
      }
      if (!navigator.onLine || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const value = await api<T>(path);
        if (alive) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        busy = false;
        if (alive) {
          setLoading(false);
          setSettledPath(path);
        }
        if (again && alive) {
          again = false;
          void load();
        }
      }
    };
    trigger.current = load;
    const refresh = () => {
      void load();
    };
    const timer = window.setInterval(() => {
      if (!busy) void load();
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
    loading: loading || settledPath !== path,
    reload: useCallback(() => trigger.current(), []),
  };
}
