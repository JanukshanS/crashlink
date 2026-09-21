/** §5.4.4 bikes & devices, §5.4.5 rentals, §5.4.7 dashboard. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BikeDetailDto,
  BikeSummaryDto,
  CreateBikeRequest,
  CreateRentalRequest,
  CreateRentalResponse,
  DriverLookupResult,
  PairDeviceRequest,
  RentalDetailDto,
  RentalSummaryDto,
} from '@crashlink/contracts';
import { api } from '../client';
import { queryKeys, REFETCH_INTERVALS } from '../queryKeys';

export const useBikes = (status?: string) =>
  useQuery({
    queryKey: [...queryKeys.bikes(), status ?? 'all'],
    queryFn: async () => {
      const query = status ? `?status=${status}` : '';
      const response = await api.get<{ items: BikeSummaryDto[] }>(`/bikes${query}`);
      return response.items;
    },
    // §2.3.3: 15 s fallback poll; the socket is the fast path.
    refetchInterval: REFETCH_INTERVALS.dashboard,
  });

export const useBike = (id: string | undefined) =>
  useQuery({
    queryKey: queryKeys.bike(id ?? ''),
    queryFn: () => api.get<BikeDetailDto>(`/bikes/${id}`),
    enabled: Boolean(id),
    refetchInterval: REFETCH_INTERVALS.dashboard,
  });

export const useCreateBike = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBikeRequest) => api.post<BikeSummaryDto>('/bikes', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bikes() }),
  });
};

export const usePairDevice = (bikeId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PairDeviceRequest) =>
      api.post<BikeSummaryDto>(`/bikes/${bikeId}/pair`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bike(bikeId) });
    },
  });
};

export const useUnpairDevice = (bikeId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/bikes/${bikeId}/pair`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bike(bikeId) });
    },
  });
};

/** §5.4.3: exact-match lookup only; no directory browsing. */
export const useDriverLookup = (query: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.driverLookup(query),
    queryFn: () => api.get<DriverLookupResult>(`/drivers/lookup?q=${encodeURIComponent(query)}`),
    enabled: enabled && query.trim().length >= 3,
    retry: false,
  });

export const useRentals = (state?: string) =>
  useQuery({
    queryKey: [...queryKeys.rentals(), state ?? 'all'],
    queryFn: async () => {
      const query = state ? `?state=${state}` : '';
      const response = await api.get<{ items: RentalSummaryDto[] }>(`/rentals${query}`);
      return response.items;
    },
  });

export const useRental = (id: string | undefined, poll = false) =>
  useQuery({
    queryKey: queryKeys.rental(id ?? ''),
    queryFn: () => api.get<RentalDetailDto>(`/rentals/${id}`),
    enabled: Boolean(id),
    // §2.4 assign screen watches for the bike's ack.
    refetchInterval: poll ? 3_000 : false,
  });

export const useAssignRental = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRentalRequest) => api.post<CreateRentalResponse>('/rentals', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rentals() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    },
  });
};

export const useEndRental = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { rentalId: string; idempotencyKey: string }) =>
      api.post<{ state: string }>(`/rentals/${input.rentalId}/end`, {
        idempotencyKey: input.idempotencyKey,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rentals() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    },
  });
};

export const useCancelRental = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rentalId: string) => api.post<{ state: string }>(`/rentals/${rentalId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rentals() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    },
  });
};

/** FR-RENT-03: demo only, and the UI says so in red. */
export const useForceActivate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rentalId: string) =>
      api.post<{ state: string; demoOverride: boolean }>(`/rentals/${rentalId}/force-activate`, {
        confirm: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.rentals() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bikes() });
    },
  });
};

