/** §5.4.2 auth hooks. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthSession, LoginRequest, MeResponse, RegisterRequest } from '@crashlink/contracts';
import { api } from '../client';
import { queryKeys } from '../queryKeys';
import { useAuthStore } from '../../stores/auth';

export const useLogin = () => {
  const setSession = useAuthStore((state) => state.setSession);

  return useMutation({
    mutationFn: (input: LoginRequest) =>
      api.post<AuthSession>('/auth/login', input, { anonymous: true }),
    onSuccess: async (session) => {
      await setSession(session);
    },
  });
};

export const useRegister = () => {
  const setSession = useAuthStore((state) => state.setSession);

  return useMutation({
    mutationFn: (input: RegisterRequest) =>
      api.post<AuthSession>('/auth/register', input, { anonymous: true }),
    onSuccess: async (session) => {
      await setSession(session);
    },
  });
};

/** FR-AUTH-05: the read-only judge account. */
export const useGuestLogin = () => {
  const setSession = useAuthStore((state) => state.setSession);

  return useMutation({
    mutationFn: () => api.post<AuthSession>('/auth/guest', {}, { anonymous: true }),
    onSuccess: async (session) => {
      await setSession(session);
    },
  });
};

export const useLogout = () => {
  const queryClient = useQueryClient();
  const { clear, getRefreshToken } = useAuthStore.getState();

  return useMutation({
    mutationFn: async () => {
      const refreshToken = await getRefreshToken();
      if (refreshToken) {
        // Best effort: a failed revoke must not trap the user in the app.
        await api.post('/auth/logout', { refreshToken }).catch(() => undefined);
      }
    },
    onSettled: async () => {
      await clear();
      queryClient.clear();
    },
  });
};

export const useMe = (enabled = true) =>
  useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api.get<MeResponse>('/me'),
    enabled,
    staleTime: 60_000,
  });
