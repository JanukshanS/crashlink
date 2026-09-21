/**
 * §5.6.5 integrity hash.
 *
 * `sha256` of the canonical JSON (sorted keys) of
 * `{ id, bikeId, type, occurredAt, lat, lon, fixAt, evidence, sensorWindow, photoSha256 }`,
 * recomputed when the photo completes. The UI shows "Evidence integrity
 * verified" only when a fresh recomputation matches the stored hash - so the
 * hash has to be reproducible from the stored row, not from the request.
 */
import { sha256Hex } from './crypto.js';

export interface IntegrityInput {
  id: string;
  bikeId: string;
  type: string;
  occurredAt: Date | string;
  lat: number | null;
  lon: number | null;
  fixAt: Date | string | null;
  evidence: unknown;
  sensorWindow: unknown;
  photoSha256: string | null;
}

/** Deterministic JSON: object keys sorted at every depth, arrays left in order. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};

export const computeIntegrityHash = (input: IntegrityInput): string => {
  const canonical = canonicalJson({
    id: input.id,
    bikeId: input.bikeId,
    type: input.type,
    occurredAt: input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
    lat: input.lat,
    lon: input.lon,
    fixAt: input.fixAt instanceof Date ? input.fixAt.toISOString() : input.fixAt,
    evidence: input.evidence ?? null,
    sensorWindow: input.sensorWindow ?? null,
    photoSha256: input.photoSha256,
  });

  return `sha256:${sha256Hex(canonical)}`;
};

export const integrityMatches = (stored: string | null, recomputed: string): boolean =>
  stored !== null && stored === recomputed;
