/** §5.4.3 driver flows and §5.4.6 incidents & images. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EmergencyContactDto,
  IncidentDetailDto,
  IncidentSummaryDto,
  UpsertEmergencyContactRequest,
  UpsertEmergencyContactResponse,
} from '@crashlink/contracts';
import { api, ApiError } from '../client';
import { queryKeys, REFETCH_INTERVALS } from '../queryKeys';

export const useIncidents = (filters: { category?: string; bikeId?: string; state?: string } = {}) =>
  useQuery({
    queryKey: [...queryKeys.incidents(), filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.category) params.set('category', filters.category);
      if (filters.bikeId) params.set('bikeId', filters.bikeId);
      if (filters.state) params.set('state', filters.state);
      const query = params.toString() ? `?${params.toString()}` : '';

      const response = await api.get<{ items: IncidentSummaryDto[] }>(`/incidents${query}`);
      return response.items;
    },
    refetchInterval: REFETCH_INTERVALS.dashboard,
  });

export const useIncident = (id: string | undefined) =>
  useQuery({
    queryKey: queryKeys.incident(id ?? ''),
    queryFn: () => api.get<IncidentDetailDto>(`/incidents/${id}`),
    enabled: Boolean(id),
    // §2.3.3: incident detail polls every 5 s as the socket's backstop.
    refetchInterval: REFETCH_INTERVALS.emergency,
  });

/** FR-IMG-02: a short-lived signed URL, owner only. */
export const useIncidentImageUrl = (id: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.incidentImageUrl(id ?? ''),
    queryFn: () =>
      api.get<{ url: string; expiresAt: string; sha256: string; bytes: number }>(
        `/incidents/${id}/image-url`,
      ),
    enabled: Boolean(id) && enabled,
    // The URL expires in 5 minutes, so refresh it a little sooner.
    staleTime: 4 * 60_000,
    retry: false,
  });

export const useAcknowledgeIncident = (id: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (note?: string) =>
      api.post<{ state: string; ownerAckAt: string }>(`/incidents/${id}/acknowledge`, {
        ...(note ? { note } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.incident(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.incidents() });
    },
  });
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ActiveRentalResponse {
  rental: {
    id: string;
    state: string;
    startedAt: string | null;
    distanceM: number;
    bike: {
      label: string;
      ignition: { state: string; changedAt: string | null };
      location: {
        kind: 'LIVE' | 'LAST_KNOWN' | 'UNAVAILABLE';
        lat: number | null;
        lon: number | null;
        fixAt: string | null;
        ageSec: number | null;
        speedKph: number | null;
        source: 'GPS' | 'DEMO' | null;
      };
      deviceOnline: string;
    };
    ownerName: string;
    ownerPhone: string;
  } | null;
}

export const useActiveRental = () =>
  useQuery({
    queryKey: queryKeys.activeRental(),
    queryFn: () => api.get<ActiveRentalResponse>('/drivers/me/active-rental'),
    refetchInterval: REFETCH_INTERVALS.dashboard,
  });

export interface PendingQuestionResponse {
  serverTime: string;
  question: {
    incidentId: string;
    type: string;
    label: string;
    occurredAt: string;
    questionSentAt: string;
    responseDeadlineAt: string;
    myResponse: 'SAFE' | 'HELP' | null;
  } | null;
}

/**
 * §2.4 trigger 2 of 3, and FR-NOT-05: polled every 5 s while a rental is
 * active. This is what catches a question raised while the socket was down,
 * which on a 2G-ish link is not a rare case.
 */
export const usePendingQuestion = (enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.pendingQuestion(),
    queryFn: () => api.get<PendingQuestionResponse>('/drivers/me/pending-question'),
    enabled,
    refetchInterval: enabled ? REFETCH_INTERVALS.pendingQuestion : false,
    // FR-NOT-05: foreground only. focusManager (app/_layout.tsx) pauses this
    // when the app leaves the foreground; the bike SMS covers that case.
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

export const useEmergencyContact = () =>
  useQuery({
    queryKey: queryKeys.emergencyContact(),
    queryFn: async () => {
      try {
        return await api.get<EmergencyContactDto>('/drivers/me/emergency-contact');
      } catch (error) {
        // 404 means "not set yet", which is a normal state, not a failure.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });

export const useSaveEmergencyContact = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertEmergencyContactRequest) =>
      api.put<UpsertEmergencyContactResponse>('/drivers/me/emergency-contact', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emergencyContact() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
    },
  });
};

export const useDriverRentals = () =>
  useQuery({
    queryKey: queryKeys.driverRentals(),
    queryFn: async () => {
      const response = await api.get<{
        items: {
          id: string;
          bikeLabel: string;
          startedAt: string | null;
          endedAt: string | null;
          distanceM: number;
          incidentCount: number;
        }[];
      }>('/drivers/me/rentals');
      return response.items;
    },
  });

export const useDriverIncidents = () =>
  useQuery({
    queryKey: queryKeys.driverIncidents(),
    queryFn: async () => {
      const response = await api.get<{ items: IncidentSummaryDto[] }>('/drivers/me/incidents');
      return response.items;
    },
  });
