'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { useRouter } from 'next/navigation';
import { fetchApi } from '@/lib/api';
// import { jwtDecode } from 'jwt-decode'; // Optional: to decode token client-side

interface User {
  id: number;
  email: string;
  name: string | null;
  companyId: number;
  role?: string;
  phone?: string | null;
  phoneVerifiedAt?: string | null;
}

export type CompanySettings = {
  companyId: number;
  name: string;
  baseCurrency: string | null;
  timeZone: string | null;
  fiscalYearStartMonth: number;
  baseCurrencyLocked: boolean;
};

interface AuthContextType {
  user: User | null;
  token: string | null;
  companySettings: CompanySettings | null;
  isCompanySettingsLoading: boolean;
  refreshCompanySettings: () => Promise<void>;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [isCompanySettingsLoading, setIsCompanySettingsLoading] = useState(false);
  const router = useRouter();

  const refreshCompanySettings = async () => {
    if (!user?.companyId || !token) {
      setCompanySettings(null);
      setIsCompanySettingsLoading(false);
      return;
    }
    setIsCompanySettingsLoading(true);
    try {
      const s = (await fetchApi(`/companies/${user.companyId}/settings`)) as CompanySettings;
      setCompanySettings(s);
    } catch (err) {
      console.error(err);
      setCompanySettings(null);
    } finally {
      setIsCompanySettingsLoading(false);
    }
  };

  useEffect(() => {
    // Restore session from cookies on load
    const storedToken = Cookies.get('token');
    const storedUser = Cookies.get('user');

    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!user?.companyId || !token) {
      setCompanySettings(null);
      setIsCompanySettingsLoading(false);
      return;
    }

    let cancelled = false;
    setIsCompanySettingsLoading(true);
    fetchApi(`/companies/${user.companyId}/settings`)
      .then((s: CompanySettings) => {
        if (cancelled) return;
        setCompanySettings(s);
      })
      .catch((err) => {
        console.error(err);
        if (cancelled) return;
        // If we got logged out due to 401, don't keep the settings in a broken state loop.
        setCompanySettings(null);
      })
      .finally(() => {
        if (cancelled) return;
        setIsCompanySettingsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.companyId, token]);

  const login = (newToken: string, newUser: User) => {
    Cookies.set('token', newToken, { expires: 7 }); // 7 days
    Cookies.set('user', JSON.stringify(newUser), { expires: 7 });
    setToken(newToken);
    setUser(newUser);
    router.push('/');
  };

  const logout = () => {
    Cookies.remove('token');
    Cookies.remove('user');
    setToken(null);
    setUser(null);
    setCompanySettings(null);
    setIsCompanySettingsLoading(false);
    router.push('/login');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        companySettings,
        isCompanySettingsLoading,
        refreshCompanySettings,
        login,
        logout,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
