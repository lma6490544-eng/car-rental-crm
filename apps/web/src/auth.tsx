import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, type User, errorMessage } from './api';
type Session = { user: User; csrfToken: string };
type Auth = {
  user: User | null;
  loading: boolean;
  error: string | null;
  expired: boolean;
  reload: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const accept = useCallback((session: Session) => {
    setUser(session.user);
    setCsrfToken(session.csrfToken);
    setError(null);
    setExpired(false);
  }, []);
  const reload = useCallback(async () => {
    setError(null);
    try {
      accept(await api<Session>('/auth/me', { anonymous: true }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setCsrfToken(null);
      } else setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [accept]);
  useEffect(() => {
    void reload();
    const expire = () => {
      setUser(null);
      setCsrfToken(null);
      setExpired(true);
    };
    window.addEventListener('crm-session-expired', expire);
    return () => window.removeEventListener('crm-session-expired', expire);
  }, [reload]);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [userId, reload]);
  const login = async (login: string, password: string) => {
    accept(
      await api<Session>('/auth/login', {
        method: 'POST',
        body: { login, password },
        anonymous: true,
      }),
    );
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    setCsrfToken(null);
    setExpired(false);
  };
  return (
    <Context.Provider value={{ user, loading, error, expired, reload, login, logout }}>
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}
