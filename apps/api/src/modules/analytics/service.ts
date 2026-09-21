/**
 * §5.4.7 analytics and dashboard.
 *
 * Every query takes an already-resolved read scope (§5.7.2: an owner's fleet,
 * the demo fleet for GUEST, or all for ADMIN), resolved once in the route, so
 * nothing here can widen what a caller may read.
 *
 * Days are counted in `TZ_DISPLAY` (Asia/Colombo): an owner reading "3
 * incidents on 21 Sep" means their 21 Sep, not UTC's, and a crash at 01:00
 * local time must not be filed under the previous day.
 */
import type { PrismaClient } from '@prisma/client';
import {
  ANALYTICS_DEFAULT_RANGE_DAYS,
  ANALYTICS_MAX_RANGE_DAYS,
  INCIDENT_CATEGORIES,
  OPEN_INCIDENT_STATES,
  OPEN_RENTAL_STATES,
  POTHOLE_MAP_LIMIT,
  type AnalyticsRangeQuery,
  type DashboardResponse,
  type IncidentCategory,
  type IncidentType,
  type IncidentsTimeseriesItem,
  incidentTypeLabel,
} from '@crashlink/contracts';
import { validationFailed } from '../../lib/errors.js';
import { scopeWhere, type ReadScope } from '../../lib/ownership.js';
import { Prisma } from '@prisma/client';
import { addDaysToKey, toIsoRequired, zonedDateKey, zonedDayStart, type Clock } from '../../lib/time.js';
import { bikeInclude, buildBikeSummary, deviceOnlineState, type BikeWithRelations } from '../bikes/service.js';
import { toIncidentSummary } from '../incidents/service.js';

export interface AnalyticsDeps {
  prisma: PrismaClient;
  clock: Clock;
  timeZone: string;
}

export interface ResolvedRange {
  from: Date;
  to: Date;
}

/** Decisions that end the §2.3.5 "response outcomes" funnel. */
const OUTCOME_DECISIONS = ['SAFE', 'HELP', 'TIMEOUT', 'OFFLINE_FALLBACK'] as const;

/** Recent-activity feed length on the dashboard (§2.3.6: "last 10 events"). */
const RECENT_LIMIT = 10;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

export class AnalyticsService {
  constructor(private readonly deps: AnalyticsDeps) {}

  /**
   * `?from&to` -> a validated range. Defaults to the last 30 days ending now.
   * A reversed or over-long range is a 400, not a silent correction: a chart
   * that quietly shows a different period than the one asked for is wrong.
   */
  resolveRange(query: AnalyticsRangeQuery): ResolvedRange {
    const now = this.deps.clock.now();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - ANALYTICS_DEFAULT_RANGE_DAYS * 86_400_000);

    if (from.getTime() >= to.getTime()) {
      throw validationFailed('`from` must be earlier than `to`.', {
        from: toIsoRequired(from),
        to: toIsoRequired(to),
      });
    }

    const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
    if (spanDays > ANALYTICS_MAX_RANGE_DAYS) {
      throw validationFailed(`A range may cover at most ${ANALYTICS_MAX_RANGE_DAYS} days.`, {
        requestedDays: Math.ceil(spanDays),
      });
    }

    return { from, to };
  }

  // -------------------------------------------------------------------------
  // GET /owners/me/dashboard
  // -------------------------------------------------------------------------

  /** §2.3.6 owner dashboard, in one round trip. */
  async dashboard(scope: ReadScope): Promise<DashboardResponse> {
    const owner = scopeWhere(scope);
    const { prisma, clock, timeZone } = this.deps;
    const now = clock.now();
    const dayStart = zonedDayStart(now, timeZone);

    const [bikes, openCounts, activeRentals, openIncidents, incidentsToday, openEmergency, recent] =
      await Promise.all([
        prisma.bike.findMany({
          where: { ...owner },
          include: bikeInclude(OPEN_RENTAL_STATES),
          orderBy: { createdAt: 'asc' },
        }) as unknown as Promise<BikeWithRelations[]>,
        prisma.incident.groupBy({
          by: ['bikeId'],
          where: { ...owner, state: { in: [...OPEN_INCIDENT_STATES] } },
          _count: { _all: true },
        }),
        // "Active" means the bike confirmed the assignment - a PENDING_SYNC
        // rental is not yet protecting anyone.
        prisma.rental.count({ where: { ...owner, state: 'ACTIVE' } }),
        prisma.incident.count({ where: { ...owner, state: { in: [...OPEN_INCIDENT_STATES] } } }),
        prisma.incident.count({ where: { ...owner, occurredAt: { gte: dayStart, lte: now } } }),
        // §2.3.6: the emergency banner - the most recent one still unresolved.
        prisma.incident.findFirst({
          where: { ...owner, category: 'EMERGENCY', state: { in: [...OPEN_INCIDENT_STATES] } },
          include: { bike: { select: { label: true } } },
          orderBy: { occurredAt: 'desc' },
        }),
        prisma.incident.findMany({
          where: { ...owner },
          include: { bike: { select: { label: true } } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: RECENT_LIMIT,
        }),
      ]);

    const countByBike = new Map(openCounts.map((row) => [row.bikeId, row._count._all]));

    const bikesOnline = bikes.filter(
      (bike) =>
        bike.device &&
        deviceOnlineState(bike.device.lastSeenAt, bike.ignition === 'ON', bike.device.config, now) ===
          'ONLINE',
    ).length;

    return {
      kpis: {
        bikesOnline,
        bikesTotal: bikes.length,
        activeRentals,
        openIncidents,
        incidentsToday,
      },
      openEmergency: openEmergency ? toIncidentSummary(openEmergency as never) : null,
      bikes: bikes.map((bike) => buildBikeSummary(bike, countByBike.get(bike.id) ?? 0, now)),
      recent: recent.map((incident) => toIncidentSummary(incident as never)),
    };
  }

  // -------------------------------------------------------------------------
  // GET /analytics/incidents-by-type
  // -------------------------------------------------------------------------

  /** Only types that occurred, most frequent first - an empty bar says nothing. */
  async incidentsByType(scope: ReadScope, range: ResolvedRange) {
    const owner = scopeWhere(scope);
    const rows = await this.deps.prisma.incident.groupBy({
      by: ['type'],
      where: { ...owner, occurredAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    });

    return {
      items: rows
        .map((row) => ({
          type: row.type as IncidentType,
          label: incidentTypeLabel(row.type as IncidentType),
          count: row._count._all,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  }

  // -------------------------------------------------------------------------
  // GET /analytics/incidents-timeseries
  // -------------------------------------------------------------------------

  /**
   * One row per local day in the range, **including days with nothing**. A
   * line that skips empty days draws a slope between two busy days and makes a
   * quiet week look like a busy one.
   */
  async incidentsTimeseries(scope: ReadScope, range: ResolvedRange): Promise<{ items: IncidentsTimeseriesItem[] }> {
    const { prisma, timeZone } = this.deps;
    const ownerFilter =
      scope.kind === 'all' ? Prisma.empty : Prisma.sql`AND owner_id = ${scope.ownerId}::uuid`;

    // Grouped in SQL, in the owner's time zone, so the day a crash is filed
    // under is the day it happened where it happened.
    const rows = await prisma.$queryRaw<{ day: string; category: IncidentCategory; count: number }[]>`
      SELECT to_char((occurred_at AT TIME ZONE ${timeZone}::text)::date, 'YYYY-MM-DD') AS day,
             category::text AS category,
             COUNT(*)::int AS count
      FROM incidents
      WHERE occurred_at >= ${range.from}::timestamptz
        AND occurred_at <= ${range.to}::timestamptz
        ${ownerFilter}
      GROUP BY 1, 2
    `;

    const byDay = new Map<string, IncidentsTimeseriesItem>();
    const firstKey = zonedDateKey(range.from, timeZone);
    const lastKey = zonedDateKey(range.to, timeZone);

    for (let key = firstKey; key <= lastKey; key = addDaysToKey(key, 1)) {
      byDay.set(key, { date: key, EMERGENCY: 0, SECURITY: 0, INFO: 0 });
    }

    for (const row of rows) {
      const bucket = byDay.get(row.day);
      if (bucket && (INCIDENT_CATEGORIES as readonly string[]).includes(row.category)) {
        bucket[row.category] += Number(row.count);
      }
    }

    return { items: [...byDay.values()] };
  }

  // -------------------------------------------------------------------------
  // GET /analytics/distance-by-bike
  // -------------------------------------------------------------------------

  /**
   * Sum of trip distance for rentals that **started** in the range. Every bike
   * is listed, including those with no rides, so the owner can see which bikes
   * sat idle - an idle bike is information, not an absence of data.
   *
   * TODO(spec): §5.4.7 does not say how a ride spanning the range boundary is
   * attributed; counting it by start time never double-counts a ride.
   */
  async distanceByBike(scope: ReadScope, range: ResolvedRange) {
    const { prisma } = this.deps;
    const owner = scopeWhere(scope);

    const [bikes, sums] = await Promise.all([
      prisma.bike.findMany({
        where: { ...owner },
        select: { id: true, label: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.rental.groupBy({
        by: ['bikeId'],
        where: { ...owner, startedAt: { gte: range.from, lte: range.to } },
        _sum: { distanceMeters: true },
      }),
    ]);

    const distance = new Map(sums.map((row) => [row.bikeId, row._sum.distanceMeters ?? 0]));

    return {
      items: bikes
        .map((bike) => ({
          bikeId: bike.id,
          label: bike.label,
          distanceM: Math.round(distance.get(bike.id) ?? 0),
        }))
        .sort((a, b) => b.distanceM - a.distanceM || a.label.localeCompare(b.label)),
    };
  }

  // -------------------------------------------------------------------------
  // GET /analytics/response-outcomes
  // -------------------------------------------------------------------------

  /**
   * How EMERGENCY safety checks ended, and how long accepted answers took.
   *
   * The median counts only **accepted** responses, measured from
   * `questionSentAt` on the server's clock. A late, refused answer is not a
   * response time - it is the absence of one, already counted as TIMEOUT.
   */
  async responseOutcomes(scope: ReadScope, range: ResolvedRange) {
    const { prisma } = this.deps;
    const owner = scopeWhere(scope);

    const [decisions, responses] = await Promise.all([
      prisma.incident.groupBy({
        by: ['decision'],
        where: {
          ...owner,
          category: 'EMERGENCY',
          occurredAt: { gte: range.from, lte: range.to },
          decision: { in: [...OUTCOME_DECISIONS] },
        },
        _count: { _all: true },
      }),
      prisma.driverResponse.findMany({
        where: {
          accepted: true,
          incident: {
            ...owner,
            category: 'EMERGENCY',
            occurredAt: { gte: range.from, lte: range.to },
            questionSentAt: { not: null },
          },
        },
        select: { serverReceivedAt: true, incident: { select: { questionSentAt: true } } },
      }),
    ]);

    const counts = { SAFE: 0, HELP: 0, TIMEOUT: 0, OFFLINE_FALLBACK: 0 };
    for (const row of decisions) {
      counts[row.decision as keyof typeof counts] = row._count._all;
    }

    const seconds = responses
      .filter((response) => response.incident.questionSentAt)
      .map(
        (response) =>
          (response.serverReceivedAt.getTime() - response.incident.questionSentAt!.getTime()) / 1000,
      )
      .filter((value) => value >= 0);

    const mid = median(seconds);

    return {
      ...counts,
      medianResponseSec: mid === null ? null : Math.round(mid * 10) / 10,
    };
  }

  // -------------------------------------------------------------------------
  // GET /analytics/potholes
  // -------------------------------------------------------------------------

  /** Pothole markers for the map; only events that carried a position. */
  async potholes(scope: ReadScope, range: ResolvedRange) {
    const owner = scopeWhere(scope);
    const rows = await this.deps.prisma.incident.findMany({
      where: {
        ...owner,
        type: 'POSSIBLE_POTHOLE',
        occurredAt: { gte: range.from, lte: range.to },
        lat: { not: null },
        lon: { not: null },
      },
      select: { lat: true, lon: true, occurredAt: true, evidence: true },
      orderBy: { occurredAt: 'desc' },
      take: POTHOLE_MAP_LIMIT,
    });

    return {
      items: rows.map((row) => {
        const peak = (row.evidence as { peakAccelerationG?: unknown } | null)?.peakAccelerationG;
        return {
          lat: row.lat!,
          lon: row.lon!,
          at: toIsoRequired(row.occurredAt),
          peakG: typeof peak === 'number' && Number.isFinite(peak) ? peak : null,
        };
      }),
    };
  }
}
