/** FR-AUTH-01..03 - register, login, and refresh-token rotation (§5.4.2, §5.7.1). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  createTestContext,
  destroyTestContext,
  registerUser,
  resetDatabase,
  TEST_PASSWORD,
  type TestContext,
} from './helpers.js';
import { sha256Hex } from '../src/lib/crypto.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
});

describe('POST /auth/register', () => {
  it('creates an owner and returns a session', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        role: 'OWNER',
        name: 'Arushan',
        email: 'arushan@gmail.com',
        phone: '+94771234567',
        password: TEST_PASSWORD,
        consentAccepted: true,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user).toMatchObject({ role: 'OWNER', email: 'arushan@gmail.com', phone: '+94771234567' });
    expect(body.expiresIn).toBe(ctx.config.ACCESS_TOKEN_TTL_SEC);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');

    // §5.7.1: the password is never stored in the clear.
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'arushan@gmail.com' } });
    expect(stored.passwordHash).not.toContain(TEST_PASSWORD);
    expect(stored.passwordHash.startsWith('$2')).toBe(true);
    // FR-AUTH-06: consent is recorded, not assumed.
    expect(stored.consentAt).not.toBeNull();
  });

  it('rejects a duplicate email with EMAIL_TAKEN and a duplicate phone with PHONE_TAKEN', async () => {
    await registerUser(ctx, 'OWNER', { email: 'taken@demo.lk', phone: '+94771111111' });

    const sameEmail = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        role: 'OWNER',
        name: 'Someone Else',
        email: 'taken@demo.lk',
        phone: '+94772222222',
        password: TEST_PASSWORD,
      },
    });
    expect(sameEmail.statusCode).toBe(409);
    expect(sameEmail.json().code).toBe('EMAIL_TAKEN');

    const samePhone = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        role: 'OWNER',
        name: 'Someone Else',
        email: 'other@demo.lk',
        phone: '+94771111111',
        password: TEST_PASSWORD,
      },
    });
    expect(samePhone.statusCode).toBe(409);
    expect(samePhone.json().code).toBe('PHONE_TAKEN');
  });

  it('rejects a short password and a non-E.164 phone with VALIDATION_FAILED', async () => {
    const shortPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        role: 'DRIVER',
        name: 'Short Pass',
        email: 'short@demo.lk',
        phone: '+94773333333',
        password: 'short',
      },
    });
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json().code).toBe('VALIDATION_FAILED');

    const badPhone = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        role: 'DRIVER',
        name: 'Bad Phone',
        email: 'badphone@demo.lk',
        phone: '0771234567',
        password: TEST_PASSWORD,
      },
    });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.json().code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/login', () => {
  it('accepts either the email or the phone as the identifier', async () => {
    const user = await registerUser(ctx, 'DRIVER');

    for (const identifier of [user.email, user.phone]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier, password: TEST_PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.id).toBe(user.id);
    }
  });

  it('answers a wrong password and an unknown account identically', async () => {
    const user = await registerUser(ctx, 'OWNER');

    const wrongPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: user.email, password: 'not-the-password' },
    });
    const unknownUser = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'nobody@demo.lk', password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json().code).toBe('UNAUTHORIZED');
    // Same message, so the endpoint cannot be used to enumerate accounts.
    expect(unknownUser.json().message).toBe(wrongPassword.json().message);
  });
});

describe('POST /auth/refresh - rotation (FR-AUTH-03)', () => {
  it('issues a new pair and revokes the presented token', async () => {
    const user = await registerUser(ctx, 'OWNER');

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.refreshToken).not.toBe(user.refreshToken);
    expect(typeof body.accessToken).toBe('string');

    // The old token is revoked in the database, not merely forgotten.
    const old = await ctx.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256Hex(user.refreshToken) },
    });
    expect(old.revokedAt).not.toBeNull();

    // The new one works.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: body.refreshToken },
    });
    expect(second.statusCode).toBe(200);
  });

  it('rejects a replayed token and revokes the whole family', async () => {
    const user = await registerUser(ctx, 'OWNER');

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    const rotated = first.json().refreshToken as string;

    // Replaying the already-rotated token looks like a leak.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // ...so the token issued from it is dead too, forcing a fresh login.
    const afterReplay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(afterReplay.statusCode).toBe(401);

    const live = await ctx.prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('rejects an unknown token and an expired one', async () => {
    const user = await registerUser(ctx, 'OWNER');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'f'.repeat(64) },
    });
    expect(unknown.statusCode).toBe(401);

    // Expire the stored token rather than waiting 30 days.
    await ctx.prisma.refreshToken.update({
      where: { tokenHash: sha256Hex(user.refreshToken) },
      data: { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
    });

    const expired = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('TOKEN_EXPIRED');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token so it cannot be rotated again', async () => {
    const user = await registerUser(ctx, 'DRIVER');

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: auth(user.accessToken),
      payload: { refreshToken: user.refreshToken },
    });
    expect(logout.statusCode).toBe(204);

    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('GET /me', () => {
  it('requires a bearer token and reports emergency-contact status for a driver', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('UNAUTHORIZED');

    const driver = await registerUser(ctx, 'DRIVER');
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: auth(driver.accessToken),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().hasEmergencyContact).toBe(false);
    expect(before.json().settings).toMatchObject({ notifySecurity: true, notifyInfo: false });
  });
});
