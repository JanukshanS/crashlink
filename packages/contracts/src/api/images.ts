/**
 * §4.4.3 / FR-IMG-01 - resumable chunked image upload.
 *
 * The device opens a session, PUTs sequential chunks, then asks the server to
 * verify size + SHA-256 before the photo is ever shown. A retry after a reboot
 * resumes from the server's `nextOffset`, which is the only authority on how
 * much actually arrived.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common.js';
import { ImageStateSchema } from '../enums.js';
import { SchemaVersionSchema } from '../device.js';

/** §5.7.4 / FR-IMG-01 hard caps. The device targets far less (Appendix E.1.5). */
export const IMAGE_MAX_BYTES = 204_800;
export const IMAGE_CHUNK_MAX_BYTES = 8_192;
/** Appendix E.1.5: 2 KB chunks at 9600 baud is what the modem actually sustains. */
export const IMAGE_DEFAULT_CHUNK_BYTES = 2_048;

export const Sha256HexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 hex characters');

export const OpenImageSessionRequestSchema = z.object({
  schema: SchemaVersionSchema,
  bytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
  sha256: Sha256HexSchema,
  chunkSize: z.number().int().positive().max(IMAGE_CHUNK_MAX_BYTES),
  mime: z.literal('image/jpeg').default('image/jpeg'),
});
export type OpenImageSessionRequest = z.infer<typeof OpenImageSessionRequestSchema>;

export const OpenImageSessionResponseSchema = z.object({
  sessionId: UuidSchema,
  nextOffset: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  state: ImageStateSchema,
  serverTime: IsoDateTimeSchema,
});

export const ImageChunkResponseSchema = z.object({
  nextOffset: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
  expected: z.number().int().positive(),
  state: ImageStateSchema,
  serverTime: IsoDateTimeSchema,
});

export const CompleteImageResponseSchema = z.object({
  state: ImageStateSchema,
  sha256: Sha256HexSchema.nullable(),
  bytes: z.number().int().nonnegative(),
  /** Set when the upload failed verification, so the device can decide to retry. */
  reason: z.string().nullable(),
  serverTime: IsoDateTimeSchema,
});
