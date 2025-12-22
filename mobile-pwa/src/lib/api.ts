const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

async function readResponseBody(res: Response): Promise<any> {
  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  if (isJson) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  try {
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

function makeIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getToken(): string | null {
  try {
    return localStorage.getItem('cf_token');
  } catch {
    return null;
  }
}

function clearSessionBestEffort() {
  try {
    localStorage.removeItem('cf_token');
    localStorage.removeItem('cf_user');
  } catch {
    // best-effort
  }
}

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const token = getToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>)
  };

  // Fintech safety rail: idempotency for all non-GET writes.
  const method = (options.method ?? 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  if (isWrite && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
    headers['Idempotency-Key'] = makeIdempotencyKey();
  }

  // Only set JSON content type for string bodies (we use JSON.stringify).
  if (
    options.body &&
    typeof options.body === 'string' &&
    !headers['Content-Type'] &&
    !headers['content-type']
  ) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers
  });

  if (res.status === 401) {
    const payload = await readResponseBody(res);
    const message =
      (payload && typeof payload === 'object' && ('message' in payload || 'error' in payload)
        ? ((payload as any).message || (payload as any).error)
        : null) ??
      (typeof payload === 'string' ? payload : null) ??
      'Unauthorized';

    clearSessionBestEffort();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      const qp = new URLSearchParams({ reason: 'expired' }).toString();
      window.location.assign(`/login?${qp}`);
    }

    throw new Error(message);
  }

  if (!res.ok) {
    const payload = await readResponseBody(res);
    const message =
      (payload && typeof payload === 'object' && ('message' in payload || 'error' in payload)
        ? ((payload as any).message || (payload as any).error)
        : null) ??
      (typeof payload === 'string' ? payload : null) ??
      `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return await readResponseBody(res);
}


