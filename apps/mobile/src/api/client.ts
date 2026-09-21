/**
 * API client (§4.2, §5.4.1).
 *
 * - Bearer access token on every authenticated call.
 * - On a 401, refreshes **once** and replays the request (§2.3.1). Concurrent
 *   401s share one refresh, so a screen with five queries does not burn five
 *   refresh tokens and trip the server's reuse detection.
 * - Maps the §5.4.1 error body to a typed error the UI can branch on.
 * - Records the server clock offset from every `serverTime` it sees, which is
 *   what the emergency countdown runs on (§2.4).
 */
import Constants from 'expo-constants';
import type { ErrorCode } from '@crashlink/contracts';
import { useAuthStore } from '../stores/auth';
import { useRealtimeStore } from '../stores/realtime';

const configuredUrl =
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  process.env.EXPO_PUBLIC_API_URL ??
  // Android emulator's alias for the host machine.
  'http://10.0.2.2:3000';

export const API_BASE_URL = configuredUrl.replace(/\/$/, '');
export const API_V1 = `${API_BASE_URL}/api/v1`;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK' | 'UNKNOWN',
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the request never reached the server (§2.4 "Cannot reach server"). */
  get isNetworkError(): boolean {
    return this.code === 'NETWORK';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skips the Authorization header (login, register, guest, refresh). */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** Set to false to stop a 401 triggering a refresh (used by refresh itself). */
  allowRefresh?: boolean;
}

/** One in-flight refresh shared by every caller that hits a 401 at once. */
let refreshInFlight: Promise<string | null> | null = null;

const performRefresh = async (): Promise<string | null> => {
  const auth = useAuthStore.getState();
  const refreshToken = await auth.getRefreshToken();
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${API_V1}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // The refresh token is dead (expired, revoked, or reused). Signing out is
      // the honest outcome - silently retrying would loop forever.
      await auth.clear();
      return null;
    }

    const body = (await response.json()) as { accessToken: string; refreshToken: string };
    const user = auth.user;
    if (user) {
      await auth.setSession({ user, accessToken: body.accessToken, refreshToken: body.refreshToken });
    } else {
      auth.setAccessToken(body.accessToken);
    }
    return body.accessToken;
  } catch {
    // A network failure is not a bad token: keep the session and let the caller
    // surface "cannot reach server".
    return null;
  }
};

const refreshAccessToken = async (): Promise<string | null> => {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
};

const parseError = async (response: Response): Promise<ApiError> => {
  try {
    const body = (await response.json()) as {
      code?: ErrorCode;
      message?: string;
      details?: Record<string, unknown>;
      requestId?: string;
    };
    return new ApiError(
      body.code ?? 'UNKNOWN',
      body.message ?? `Request failed (${response.status})`,
      response.status,
      body.details ?? {},
      body.requestId,
    );
  } catch {
    return new ApiError('UNKNOWN', `Request failed (${response.status})`, response.status);
  }
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const { method = 'GET', body, anonymous = false, signal, allowRefresh = true } = options;

  const send = async (token: string | null): Promise<Response> => {
    const startedAt = Date.now();

    const response = await fetch(`${API_V1}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token && !anonymous ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });

    // Every response carrying a server clock improves the offset (§2.4).
    const serverDate = response.headers.get('date');
    if (serverDate) {
      const parsed = new Date(serverDate);
      if (!Number.isNaN(parsed.getTime())) {
        useRealtimeStore.getState().syncClock(parsed.toISOString(), startedAt);
      }
    }

    return response;
  };

  let response: Response;
  try {
    response = await send(useAuthStore.getState().accessToken);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('NETWORK', 'Cannot reach the server.', 0);
  }

  // §2.3.1: auto-refresh on 401, once.
  if (response.status === 401 && !anonymous && allowRefresh) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      try {
        response = await send(refreshed);
      } catch {
        throw new ApiError('NETWORK', 'Cannot reach the server.', 0);
      }
    }
  }

  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  const parsed = JSON.parse(text) as T;

  // Endpoints that return their own `serverTime` are the most accurate source
  // of the offset, because it is generated at handling time.
  const withServerTime = parsed as { serverTime?: string };
  if (withServerTime?.serverTime) {
    useRealtimeStore.getState().syncClock(withServerTime.serverTime, Date.now());
  }

  return parsed;
};

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};
