/** Query keys in one place, so socket invalidation and hooks cannot drift. */
export const queryKeys = {
  me: () => ['me'] as const,

  dashboard: () => ['dashboard'] as const,

  bikes: () => ['bikes'] as const,
  bike: (id: string) => ['bikes', id] as const,

  rentals: () => ['rentals'] as const,
  rental: (id: string) => ['rentals', id] as const,
  activeRental: () => ['drivers', 'active-rental'] as const,
  driverRentals: () => ['drivers', 'rentals'] as const,

  incidents: () => ['incidents'] as const,
  incident: (id: string) => ['incidents', id] as const,
  driverIncidents: () => ['drivers', 'incidents'] as const,
  incidentImageUrl: (id: string) => ['incidents', id, 'image-url'] as const,

  pendingQuestion: () => ['drivers', 'pending-question'] as const,
  emergencyContact: () => ['drivers', 'emergency-contact'] as const,
  driverLookup: (q: string) => ['drivers', 'lookup', q] as const,

  analytics: () => ['analytics'] as const,
  analyticsByType: (from: string, to: string) => ['analytics', 'by-type', from, to] as const,
  analyticsTimeseries: (from: string, to: string) => ['analytics', 'timeseries', from, to] as const,
  analyticsDistance: (from: string, to: string) => ['analytics', 'distance', from, to] as const,
  analyticsOutcomes: (from: string, to: string) => ['analytics', 'outcomes', from, to] as const,
  analyticsPotholes: (from: string, to: string) => ['analytics', 'potholes', from, to] as const,

  adminDevices: () => ['admin', 'devices'] as const,
  adminUsers: () => ['admin', 'users'] as const,
  adminHealth: () => ['admin', 'health'] as const,
} as const;

/** §2.3.3 fallback polling intervals, used when the socket is the backup. */
export const REFETCH_INTERVALS = {
  /** Emergency and incident-detail screens. */
  emergency: 5_000,
  /** The driver's pending-question poll (§2.4, FR-NOT-05). */
  pendingQuestion: 5_000,
  /** Dashboard and bike detail. */
  dashboard: 15_000,
} as const;
