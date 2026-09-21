/**
 * §5.4.7 analytics & dashboard hooks.
 *
 * Ranges are "the last N local days": from midnight N-1 days ago to now, so
 * the first bar of a chart is a whole day rather than a sliver of one.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DashboardResponse,
  DistanceByBikeResponse,
  IncidentsByTypeResponse,
  IncidentsTimeseriesResponse,
  PotholesResponse,
  ResponseOutcomesResponse,
} from '@crashlink/contracts';
import { api, ApiError } from '../client';
import { queryKeys, REFETCH_INTERVALS } from '../queryKeys';

export interface AnalyticsRange {
  days: number;
  from: string;
  to: string;
}

/**
 * Builds the range once per `days`/`refreshKey`, so it does not change on
 * every render (which would refetch in a loop). Pull-to-refresh bumps
 * `refreshKey` to move `to` forward to "now".
 */
export const useAnalyticsRange = (days: number, refreshKey: number): AnalyticsRange =>
  useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return { days, from: start.toISOString(), to: now.toISOString() };
    // refreshKey is a deliberate dependency: it is how a refresh moves `to`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, refreshKey]);

const rangeQuery = (range: AnalyticsRange): string =>
  `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

/** §2.3.6 owner dashboard, one round trip. */
export const useDashboard = () =>
  useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: () => api.get<DashboardResponse>('/owners/me/dashboard'),
    // §2.3.3: 15 s fallback; the socket invalidates it the moment anything moves.
    refetchInterval: REFETCH_INTERVALS.dashboard,
  });

export const useIncidentsByType = (range: AnalyticsRange) =>
  useQuery({
    queryKey: queryKeys.analyticsByType(range.from, range.to),
    queryFn: () => api.get<IncidentsByTypeResponse>(`/analytics/incidents-by-type?${rangeQuery(range)}`),
  });

export const useIncidentsTimeseries = (range: AnalyticsRange) =>
  useQuery({
    queryKey: queryKeys.analyticsTimeseries(range.from, range.to),
    queryFn: () =>
      api.get<IncidentsTimeseriesResponse>(
        `/analytics/incidents-timeseries?${rangeQuery(range)}&bucket=day`,
      ),
  });

export const useDistanceByBike = (range: AnalyticsRange) =>
  useQuery({
    queryKey: queryKeys.analyticsDistance(range.from, range.to),
    queryFn: () => api.get<DistanceByBikeResponse>(`/analytics/distance-by-bike?${rangeQuery(range)}`),
  });

/**
 * OWNER only per §5.4.7. For a GUEST the server answers 403; the hook reports
 * that as `forbidden` so the screen can say why the card is missing instead of
 * showing a generic error.
 */
export const useResponseOutcomes = (range: AnalyticsRange, enabled: boolean) => {
  const query = useQuery({
    queryKey: queryKeys.analyticsOutcomes(range.from, range.to),
    queryFn: () =>
      api.get<ResponseOutcomesResponse>(`/analytics/response-outcomes?${rangeQuery(range)}`),
    enabled,
    retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 2,
  });

  const forbidden = query.error instanceof ApiError && query.error.status === 403;
  return { ...query, forbidden };
};

export const usePotholes = (range: AnalyticsRange) =>
  useQuery({
    queryKey: queryKeys.analyticsPotholes(range.from, range.to),
    queryFn: () => api.get<PotholesResponse>(`/analytics/potholes?${rangeQuery(range)}`),
  });
