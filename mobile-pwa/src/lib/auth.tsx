import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from './types';
import { clearSession, getToken, getUser, setToken, setUser } from './storage';

type AuthState = {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUserState] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    const u = getUser<User>();
    setTokenState(t);
    setUserState(u);
    setIsLoading(false);
  }, []);

  const value = useMemo<AuthState>(() => {
    return {
      token,
      user,
      isLoading,
      login: (newToken, newUser) => {
        setToken(newToken);
        setUser(newUser);
        setTokenState(newToken);
        setUserState(newUser);
      },
      logout: () => {
        clearSession();
        setTokenState(null);
        setUserState(null);
      }
    };
  }, [token, user, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}


