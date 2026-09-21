/**
 * Geography helpers - §5.6.5 "Trip distance" and the §5.3.3 coordinate rules.
 */

export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export const haversine = (a: Point, b: Point): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * §5.3.3: coordinates outside ±90/±180 - and the (0,0) "null island" a GPS
 * module emits before it has a fix - are rejected per item, not per request.
 */
export const isPlausibleCoordinate = (lat: number, lon: number): boolean => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
};

/** §5.6.5 trip distance: ≥ 5 m of movement, ≤ 150 km/h implied, HDOP ≤ 5. */
export const DISTANCE_MIN_MOVE_M = 5;
export const DISTANCE_MAX_SPEED_MPS = 41.7;
export const DISTANCE_MAX_HDOP = 5;

export interface DistanceCandidate {
  lat: number;
  lon: number;
  fixAt: Date;
  hdop?: number | null;
  valid: boolean;
}

export interface DistanceAnchor {
  lat: number;
  lon: number;
  at: Date;
}

/**
 * Returns the metres to add for one fix, or null if the fix should not move the
 * odometer. Rejecting an implausible jump matters: a single bad fix would
 * otherwise add kilometres to a rider's trip.
 */
export const distanceIncrement = (
  anchor: DistanceAnchor | null,
  fix: DistanceCandidate,
): number | null => {
  if (!fix.valid) return null;
  if (fix.hdop !== null && fix.hdop !== undefined && fix.hdop > DISTANCE_MAX_HDOP) return null;
  if (!isPlausibleCoordinate(fix.lat, fix.lon)) return null;
  if (!anchor) return null;

  const metres = haversine(anchor, fix);
  if (metres < DISTANCE_MIN_MOVE_M) return null;

  const deltaSec = (fix.fixAt.getTime() - anchor.at.getTime()) / 1000;
  if (deltaSec <= 0) return null;
  if (metres / deltaSec > DISTANCE_MAX_SPEED_MPS) return null;

  return metres;
};
