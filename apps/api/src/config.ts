/**
 * Zod-validated environment (§4.3, Appendix B).
 *
 * The process refuses to start with a bad or missing value rather than
 * discovering it at 9 a.m. on demo day.
 */
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback ? 'true' : 'false');

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex (openssl rand -hex 32)');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  DEVICE_BASE_URL: z.string().url().default('http://localhost:3000'),
  TZ_DISPLAY: z.string().default('Asia/Colombo'),

  DATABASE_URL: z.string().min(1),

  // §5.7.1 - JWT_SECRET must be at least 32 bytes.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  DEVICE_SECRET_KEY: hex32,
  FILE_URL_SECRET: z.string().min(16),
  ADMIN_SEED_PASSWORD: z.string().min(8).optional(),

  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Locked incident policy (pinned decisions in CLAUDE.md, §5.3.9 S5).
  FALL_CONFIRM_SEC: z.coerce.number().int().default(10),
  RESPONSE_WINDOW_SEC: z.coerce.number().int().default(60),
  DEADLINE_GRACE_SEC: z.coerce.number().int().default(15),
  DEADMAN_ON_SEC: z.coerce.number().int().default(90),
  DEADMAN_OFF_SEC: z.coerce.number().int().default(300),

  IMAGE_DIR: z.string().default('/data/images'),
  IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(204800),
  IMAGE_CHUNK_MAX_BYTES: z.coerce.number().int().positive().default(8192),
  // §5.7.1: signed image URLs expire in at most 5 minutes.
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().max(300).default(300),

  RETENTION_LOCATIONS_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_IMAGES_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(180),

  DEMO_MODE: bool(false),
  GUEST_ENABLED: bool(false),

  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema> & {
  /** §5.3.9: the two safety parameters an owner may never change. */
  lockedConfig: { fallConfirmSec: number; responseWindowSec: number };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }

  const env = parsed.data;

  // The team pinned these (CLAUDE.md). Warn loudly rather than silently drifting.
  if (env.FALL_CONFIRM_SEC !== 10 || env.RESPONSE_WINDOW_SEC !== 60) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] Safety parameters differ from the pinned decisions: ` +
        `fallConfirmSec=${env.FALL_CONFIRM_SEC} (expected 10), ` +
        `responseWindowSec=${env.RESPONSE_WINDOW_SEC} (expected 60).`,
    );
  }

  return {
    ...env,
    lockedConfig: {
      fallConfirmSec: env.FALL_CONFIRM_SEC,
      responseWindowSec: env.RESPONSE_WINDOW_SEC,
    },
  };
};
