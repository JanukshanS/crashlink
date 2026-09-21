/**
 * authStore (§4.2) - user, tokens, role.
 *
 * The refresh token lives in `expo-secure-store` (§2.3.1), never in the Zustand
 * state that gets persisted to AsyncStorage: AsyncStorage is world-readable on
 * a rooted device, and the refresh token is a 30-day credential.
 *
 * The access token is kept in memory only. It lasts an hour, so losing it on
 * cold start costs one refresh call, which is a better trade than writing it to
 * disk.
 */
import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { Role, UserDto } from '@crashlink/contracts';

const REFRESH_TOKEN_KEY = 'crashlink.refreshToken';
const USER_KEY = 'crashlink.user';

export interface AuthState {
  user: UserDto | null;
  accessToken: string | null;
  /** Set once the stored session has been read, so the gate stops flashing. */
  hydrated: boolean;

  setSession: (input: { user: UserDto; accessToken: string; refreshToken: string }) => Promise<void>;
  setAccessToken: (accessToken: string) => void;
  setUser: (user: UserDto) => Promise<void>;
  restore: () => Promise<void>;
  clear: () => Promise<void>;
  getRefreshToken: () => Promise<string | null>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  hydrated: false,

  setSession: async ({ user, accessToken, refreshToken }) => {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
    set({ user, accessToken });
  },

  setAccessToken: (accessToken) => set({ accessToken }),

  setUser: async (user) => {
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
    set({ user });
  },

  restore: async () => {
    try {
      const raw = await SecureStore.getItemAsync(USER_KEY);
      const user = raw ? (JSON.parse(raw) as UserDto) : null;
      // The access token is deliberately not restored; the client refreshes it
      // on the first authenticated call.
      set({ user, hydrated: true });
    } catch {
      set({ user: null, accessToken: null, hydrated: true });
    }
  },

  clear: async () => {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => undefined);
    await SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined);
    set({ user: null, accessToken: null });
  },

  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
}));

/** §2.1 role routing: OWNER/GUEST -> (owner), DRIVER -> (driver), ADMIN -> (admin). */
export const routeGroupForRole = (role: Role): '(owner)' | '(driver)' | '(admin)' => {
  switch (role) {
    case 'DRIVER':
      return '(driver)';
    case 'ADMIN':
      return '(admin)';
    case 'OWNER':
    case 'GUEST':
    default:
      return '(owner)';
  }
};

/**
 * §2.1 / §5.7.2: the guest account is read-only. Every mutation control checks
 * this rather than relying on the server's 403 - a button that cannot work
 * should not be offered.
 */
export const useIsReadOnly = (): boolean => useAuthStore((state) => state.user?.role === 'GUEST');

export const useCurrentUser = (): UserDto | null => useAuthStore((state) => state.user);
