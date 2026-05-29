import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, api } from "../api";
import { clearApiCache, setCacheScope } from "../hooks/useApi";
import type { User } from "../types";

type Status = "loading" | "anon" | "authed";

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  /** Create the account and sign in immediately (the backend sets the
   *  session cookie). */
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Permanently delete the current user + all their data. */
  deleteAccount: () => Promise<void>;
  /** Re-fetch /api/auth/me — useful after the server may have changed state. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setCacheScope(me.id);
      setUser(me);
      setStatus("authed");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setCacheScope(null);
        setUser(null);
        setStatus("anon");
      } else {
        // Unknown error — staying in `loading` would hide the UI; treat as anon
        // so the login page renders and the user can retry.
        setCacheScope(null);
        setUser(null);
        setStatus("anon");
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.login(email, password);
    setCacheScope(u.id);
    setUser(u);
    setStatus("authed");
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const u = await api.signup(email, password);
    setCacheScope(u.id);
    setUser(u);
    setStatus("authed");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      clearApiCache();
      setCacheScope(null);
      setUser(null);
      setStatus("anon");
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    // Let the API error propagate to the caller so the UI can show it. Only
    // tear down local auth state once the server has confirmed the delete —
    // otherwise a transient failure would log the user out without actually
    // removing anything.
    await api.deleteMe();
    clearApiCache();
    setCacheScope(null);
    setUser(null);
    setStatus("anon");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, signup, logout, deleteAccount, refresh }),
    [status, user, login, signup, logout, deleteAccount, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
