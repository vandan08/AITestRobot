import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

const TOKEN_KEY = "demo.token";

interface AuthValue {
  token: string | null;
  signIn: (token: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue>({
  token: null,
  signIn: () => {},
  signOut: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    window.localStorage.getItem(TOKEN_KEY),
  );

  const value = useMemo<AuthValue>(
    () => ({
      token,
      signIn: (next) => {
        window.localStorage.setItem(TOKEN_KEY, next);
        setToken(next);
      },
      signOut: () => {
        window.localStorage.removeItem(TOKEN_KEY);
        setToken(null);
      },
    }),
    [token],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function readToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}
