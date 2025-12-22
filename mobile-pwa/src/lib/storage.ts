const TOKEN_KEY = 'cf_token';
const USER_KEY = 'cf_user';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // best-effort
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // best-effort
  }
}

export function getUser<T = any>(): T | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setUser(user: unknown) {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // best-effort
  }
}

export function clearUser() {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    // best-effort
  }
}

export function clearSession() {
  clearToken();
  clearUser();
}


