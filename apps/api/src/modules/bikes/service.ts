/**
 * Bike read models: the BikeSummaryDto / BikeDetailDto of §5.4.1 and §5.4.4,
 * including the derived values from §5.6.5 (online state, location freshness).
 */
import type { Bike, Device, Prisma, Rental } from '@prisma/client';
import {
  type BikeSummaryDto,
  type DeviceHealthDto,
  type DeviceOnlineState,
  type LocationDto,
  DeviceConfigSchema,
  DeviceHealthSchema,
} from '@crashlink/contracts';
import { toIso, toIsoRequired } from '../../lib/time.js';

export type BikeWithRelations = Bike & {
  device: Device | null;
  rentals: (Rental & { driver: { name: string } })[];
  _count?: { incidents: number };
};

/** What a summary needs; kept in one place so list and detail cannot drift. */
export const bikeInclude = (openStates: readonly string[]) =>
  ({
    device: true,
    rentals: {
      where: { state: { in: openStates as Prisma.Enumerable<never> } },
      include: { driver: { select: { name: true } } },
      orderBy: { assignmentVersion: 'desc' },
      take: 1,
    },
  }) satisfies Prisma.BikeInclude;

/**
 * §5.6.5 "Online state": expected interval is telemetryOnSec when the ignition
 * is ON and telemetryOffSec otherwise; ONLINE within 2.5x, STALE within 5x.
 */
export const deviceOnlineState = (
  lastSeenAt: Date | null,
  ignitionOn: boolean,
  config: unknown,
  now: Date,
): DeviceOnlineState => {
  if (!lastSeenAt) return 'OFFLINE';

  const parsed = DeviceConfigSchema.safeParse(config);
  const expected = parsed.success
    ? ignitionOn
      ? parsed.data.telemetryOnSec
      : parsed.data.telemetryOffSec
    : ignitionOn
      ? 10
      : 60;

  const ageSec = (now.getTime() - lastSeenAt.getTime()) / 1000;
  if (ageSec <= 2.5 * expected) return 'ONLINE';
  if (ageSec <= 5 * expected) return 'STALE';
  return 'OFFLINE';
};

/**
 * FR-MON-03 location freshness. A fix older than 60 s is LAST_KNOWN, not LIVE:
 * the UI must never imply the dot on the map is where the bike is right now.
 */
const LIVE_FIX_MAX_AGE_SEC = 60;

export const buildLocationDto = (bike: Bike, now: Date): LocationDto => {
  if (bike.lastLat === null || bike.lastLon === null || !bike.lastFixAt) {
    return { kind: 'UNAVAILABLE', lat: null, lon: null, fixAt: null, ageSec: null, speedKph: null, source: null };
  }

  const ageSec = Math.max(0, Math.round((now.getTime() - bike.lastFixAt.getTime()) / 1000));

  return {
    kind: ageSec <= LIVE_FIX_MAX_AGE_SEC ? 'LIVE' : 'LAST_KNOWN',
    lat: bike.lastLat,
    lon: bike.lastLon,
    fixAt: toIso(bike.lastFixAt),
    ageSec,
    speedKph: bike.lastSpeedKph,
    source: bike.lastLocationSource,
  };
};

/** CSQ 0-31 mapped to 0-5 bars; 99 means "not known" and yields null. */
export const signalBars = (csq: number | null): number | null => {
  if (csq === null || csq >= 99 || csq < 0) return null;
  if (csq <= 2) return 0;
  if (csq <= 9) return 1;
  if (csq <= 14) return 2;
  if (csq <= 19) return 3;
  if (csq <= 25) return 4;
  return 5;
};

/** M10: battery is never measured, so `batteryV` is always null - "Not measured". */
export const buildHealthDto = (device: Device | null): DeviceHealthDto | null => {
  if (!device?.lastHealth) return null;

  const parsed = DeviceHealthSchema.safeParse(device.lastHealth);
  if (!parsed.success) return null;

  const { resetReason: _resetReason, ...health } = parsed.data;
  return {
    ...health,
    batteryV: null,
    signalBars: signalBars(health.csq),
    fw: device.firmwareVersion,
  };
};

export const buildBikeSummary = (
  bike: BikeWithRelations,
  openIncidentCount: number,
  now: Date,
): BikeSummaryDto => {
  const activeRental = bike.rentals[0];

  return {
    id: bike.id,
    label: bike.label,
    plateNo: bike.plateNo,
    status: bike.status,
    device: bike.device
      ? {
          code: bike.device.code,
          online: deviceOnlineState(bike.device.lastSeenAt, bike.ignition === 'ON', bike.device.config, now),
          lastSeenAt: toIso(bike.device.lastSeenAt),
          configVersion: bike.device.configVersion,
          // FR-DEV-05: "pending" means the device has not yet acked this version.
          configPending: bike.device.appliedConfigVersion !== bike.device.configVersion,
        }
      : null,
    ignition: { state: bike.ignition, changedAt: toIso(bike.ignitionChangedAt) },
    location: buildLocationDto(bike, now),
    activeRental: activeRental
      ? {
          id: activeRental.id,
          state: activeRental.state,
          driverName: activeRental.driver.name,
          startedAt: toIso(activeRental.startedAt),
          distanceM: activeRental.distanceMeters,
        }
      : null,
    openIncidentCount,
  };
};

export const bikeCreatedAtIso = (bike: Bike): string => toIsoRequired(bike.createdAt);
