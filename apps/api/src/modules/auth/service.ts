/**
 * §5.4.2 auth service - FR-AUTH-01 to FR-AUTH-03, FR-AUTH-05.
 *
 * Access tokens are short-lived JWTs; refresh tokens are opaque 32-byte values
 * stored only as SHA-256 and **rotated on every use** (§5.7.1).
 *
 * No password reset in the MVP (M11) - `POST /auth/password/*` is deliberately
 * not implemented; admin creates accounts and the seed supplies demo logins.
 */
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import {
  type AuthSession,
  type LoginRequest,
  type RegisterRequest,
  type UserDto,
} from '@crashlink/contracts';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { generateRefreshToken, sha256Hex } from '../../lib/crypto.js';
import { addDays, toIsoRequired, type Clock } from '../../lib/time.js';

const BCRYPT_COST = 10;

/** §5.4.10: "5 failed logins per account per 15 min -> 429". */
const LOCKOUT_MAX_FAILURES = 5;
const LOCKOUT_WINDOW_SEC = 15 * 60;

export interface AuthServiceDeps {
  prisma: PrismaClient;
  app: FastifyInstance;
  clock: Clock;
  refreshTtlDays: number;
  accessTtlSec: number;
  guestEnabled: boolean;
}

export const toUserDto = (user: User): UserDto => ({
  id: user.id,
  role: user.role,
  name: user.name,
  email: user.email,
  phone: user.phoneE164,
  language: user.language,
  isDemo: user.isDemo,
  createdAt: toIsoRequired(user.createdAt),
});

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, BCRYPT_COST);

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  private signAccessToken(user: Pick<User, 'id' | 'role' | 'isDemo'>): string {
    return this.deps.app.jwt.sign({ sub: user.id, role: user.role, isDemo: user.isDemo });
  }

  /** Issues a fresh opaque refresh token and stores only its SHA-256 (§5.7.1). */
  private async issueRefreshToken(userId: string, tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.deps.prisma;
    const token = generateRefreshToken();
    await client.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        expiresAt: addDays(this.deps.clock.now(), this.deps.refreshTtlDays),
      },
    });
    return token;
  }

  private async buildSession(user: User): Promise<AuthSession> {
    return {
      user: toUserDto(user),
      accessToken: this.signAccessToken(user),
      refreshToken: await this.issueRefreshToken(user.id),
      expiresIn: this.deps.accessTtlSec,
    };
  }

  /** FR-AUTH-01. Self-registration is OWNER or DRIVER only; ADMIN/GUEST are seeded. */
  async register(input: RegisterRequest): Promise<AuthSession> {
    const { prisma, clock } = this.deps;

    const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingEmail) throw conflict('EMAIL_TAKEN', 'That email address is already registered.');

    const existingPhone = await prisma.user.findUnique({ where: { phoneE164: input.phone } });
    if (existingPhone) throw conflict('PHONE_TAKEN', 'That phone number is already registered.');

    const user = await prisma.user.create({
      data: {
        role: input.role,
        name: input.name,
        email: input.email,
        phoneE164: input.phone,
        passwordHash: await hashPassword(input.password),
        language: input.language ?? 'en',
        // FR-AUTH-06 / §5.7.3: the consent timestamp is recorded, never assumed.
        consentAt: input.consentAccepted ? clock.now() : null,
        settings: { create: {} },
      },
    });

    return this.buildSession(user);
  }

  /** FR-AUTH-02. `identifier` is an email or an E.164 phone number. */
  async login(input: LoginRequest): Promise<AuthSession> {
    const identifier = input.identifier.trim();
    const user = await this.deps.prisma.user.findFirst({
      where: identifier.startsWith('+')
        ? { phoneE164: identifier }
        : { email: identifier.toLowerCase() },
    });

    // Same error and roughly the same work either way, so a caller cannot probe
    // which accounts exist.
    if (!user) {
      await bcrypt.compare(input.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
      throw unauthorized('Incorrect credentials.');
    }
    if (user.disabledAt) throw unauthorized('This account is disabled.');

    /**
     * §5.4.10: 5 failed logins per account per 15 minutes -> 429. Checked
     * before the password, so a correct guess on the sixth try is still
     * refused; the per-IP limit alone would not stop a distributed guesser.
     * The window rolls - failures older than 15 minutes stop counting.
     */
    const now = this.deps.clock.now();
    const recentFailures = await this.deps.prisma.auditEvent.count({
      where: {
        action: 'LOGIN_FAILED',
        targetType: 'USER',
        targetId: user.id,
        createdAt: { gt: new Date(now.getTime() - LOCKOUT_WINDOW_SEC * 1000) },
      },
    });
    if (recentFailures >= LOCKOUT_MAX_FAILURES) {
      throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again in 15 minutes.');
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);

    // §5.7.3: logins are audit events. No password or identifier in `meta`.
    await this.deps.prisma.auditEvent.create({
      data: {
        actorType: 'USER',
        actorId: user.id,
        action: ok ? 'LOGIN_SUCCEEDED' : 'LOGIN_FAILED',
        targetType: 'USER',
        targetId: user.id,
        meta: {},
        createdAt: now,
      },
    });

    if (!ok) throw unauthorized('Incorrect credentials.');

    return this.buildSession(user);
  }

  /**
   * FR-AUTH-03 refresh rotation. The presented token is revoked and a new one
   * issued in a single transaction.
   *
   * Replaying an already-revoked token revokes the user's whole family of
   * tokens: either it leaked or a client is buggy, and both are safer handled
   * by forcing a fresh login.
   * TODO(spec): §5.4.2 does not state a reuse-detection policy; this is the
   * safest reading and is covered by a test.
   */
  async refresh(presentedToken: string): Promise<AuthSession> {
    const { prisma, clock } = this.deps;
    const tokenHash = sha256Hex(presentedToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw unauthorized('Refresh token is not valid.');

    if (stored.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: clock.now() },
      });
      throw unauthorized('Refresh token has already been used. Please sign in again.');
    }

    if (stored.expiresAt <= clock.now()) {
      throw new AppError('TOKEN_EXPIRED', 'Refresh token has expired.');
    }
    if (stored.user.disabledAt) throw unauthorized('This account is disabled.');

    const rotated = await prisma.$transaction(async (tx) => {
      // Guard against two concurrent refreshes both rotating the same token.
      const claimed = await tx.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: clock.now() },
      });
      if (claimed.count === 0) throw unauthorized('Refresh token is not valid.');
      return this.issueRefreshToken(stored.userId, tx);
    });

    return {
      user: toUserDto(stored.user),
      accessToken: this.signAccessToken(stored.user),
      refreshToken: rotated,
      expiresIn: this.deps.accessTtlSec,
    };
  }

  /** FR-AUTH-03 logout: revoke the refresh token and drop the push token. */
  async logout(presentedToken: string, pushToken?: string): Promise<void> {
    const { prisma, clock } = this.deps;

    await prisma.refreshToken.updateMany({
      where: { tokenHash: sha256Hex(presentedToken), revokedAt: null },
      data: { revokedAt: clock.now() },
    });

    if (pushToken) {
      await prisma.pushToken.deleteMany({ where: { token: pushToken } });
    }
  }

  /** FR-AUTH-05 guest/judge login into the seeded read-only account. */
  async guestLogin(): Promise<AuthSession> {
    if (!this.deps.guestEnabled) {
      throw new AppError('FORBIDDEN', 'Guest access is disabled.');
    }

    const guest = await this.deps.prisma.user.findFirst({
      where: { role: 'GUEST' },
      orderBy: { createdAt: 'asc' },
    });
    if (!guest) throw new AppError('NOT_FOUND', 'No guest account has been seeded.');

    return this.buildSession(guest);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const { prisma, clock } = this.deps;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw unauthorized();

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw unauthorized('Current password is incorrect.');

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(newPassword) },
      }),
      // A password change ends every other session.
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: clock.now() },
      }),
    ]);
  }
}
