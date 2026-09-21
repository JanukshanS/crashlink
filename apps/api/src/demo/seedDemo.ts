/**
 * §5.6.7 demo seed, as a function - called by `npm run db:seed`, by
 * `npm run demo:reset`, and by the tests.
 *
 * Creates the admin, the demo owner/driver/guest, the emergency contact, the
 * two devices (CL-0001 real hardware, CL-0002 simulator), the two bikes, and
 * 14 days of synthetic history so the analytics screens are not empty. All
 * demo data carries `isDemo = true`.
 *
 * **Device secrets are kept by default.** A device's secret lives in its
 * firmware; regenerating it on every seed would lock the real bike out until
 * someone reflashed it, which is exactly what must not happen the morning of
 * a demo. Pass `rotateDeviceSecrets` to issue new ones deliberately - they are
 * then returned once, and never again.
 *
 * Re-running is safe: users, devices and bikes are upserted by natural key and
 * synthetic history is rebuilt from scratch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { DEFAULT_DEVICE_CONFIG, type IncidentType } from '@crashlink/contracts';
import type { Config } from '../config.js';
import {
  encryptSecret,
  generateApPassword,
  generateDeviceSecret,
  generatePairingCode,
} from '../lib/crypto.js';
import { severityScore } from '../lib/severity.js';
import { stampIntegrityHash } from '../modules/incidents/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * §5.6.7 marks these as "replace with a team member's real number for the live
 * demo" - the bike really does text them.
 */
export const DEMO_PHONES = {
  ownerPhone: '+94765541123',
  driverPhone: '+94767268555',
  contactPhone: '+94774115171',
} as const;

/** The team's demo people. The bike texts these numbers for real. */
export const DEMO_PEOPLE = {
  owner: 'Arushan',
  driver: 'Janukshan',
  contact: 'Diroshan',
  contactRelationship: 'Friend',
} as const;

export const DEMO_ACCOUNTS = {
  admin: 'admin@crashlink.lk',
  owner: 'arushan@gmail.com',
  driver: 'janukshan@gmail.com',
  guest: 'judge@demo.lk',
} as const;

/**
 * Logins used by earlier seeds. They are renamed in place rather than left
 * behind, so the demo owner keeps its bikes and paired devices (CL-0001 is
 * unique to one bike) and old rentals keep resolving.
 */
const LEGACY_DEMO_EMAILS: Partial<Record<keyof typeof DEMO_ACCOUNTS, string>> = {
  owner: 'owner@demo.lk',
  driver: 'ravi@demo.lk',
};

export const DEMO_DEVICE_CODES = ['CL-0001', 'CL-0002'] as const;

export interface DeviceCredentials {
  secret: string;
  pairingCode: string;
  cameraSecret: string;
  apPassword: string;
}

export interface SeededDevice {
  id: string;
  code: string;
  /** Only when newly created or rotated - otherwise null (not recoverable). */
  credentials: DeviceCredentials | null;
}

export interface SeedOptions {
  rotateDeviceSecrets?: boolean;
  /** Write firmware/main-esp32/include/secrets.h when CL-0001 gets new credentials. */
  writeSecretsHeader?: boolean;
}

export interface SeedResult {
  ownerId: string;
  bikeIds: string[];
  devices: SeededDevice[];
  secretsPath: string | null;
  incidents: number;
}

export const seedDemo = async (
  prisma: PrismaClient,
  config: Config,
  options: SeedOptions = {},
): Promise<SeedResult> => {
  const DEMO = DEMO_PHONES;
  const DAY_MS = 86_400_000;
  /** Colombo / Malabe, where the demo route runs. */
  const COLOMBO = { lat: 6.9147, lon: 79.9729 };

  const hashPassword = (password: string) => bcrypt.hash(password, 10);

  const upsertUser = async (input: {
    role: 'ADMIN' | 'OWNER' | 'DRIVER' | 'GUEST';
    name: string;
    email: string;
    phone: string | null;
    password: string;
    isDemo: boolean;
  }) => {
    const passwordHash = await hashPassword(input.password);
    return prisma.user.upsert({
      where: { email: input.email },
      create: {
        role: input.role,
        name: input.name,
        email: input.email,
        phoneE164: input.phone,
        passwordHash,
        isDemo: input.isDemo,
        consentAt: new Date(),
        settings: { create: {} },
      },
      update: {
        role: input.role,
        name: input.name,
        phoneE164: input.phone,
        passwordHash,
        isDemo: input.isDemo,
      },
    });
  };

  /**
   * Keeps an existing device's credentials unless rotation was asked for.
   * Rotation also un-revokes, since it is the documented recovery for a
   * stolen device (§5.7.4).
   */
  const seedDevice = async (code: string): Promise<SeededDevice> => {
    const existing = await prisma.device.findUnique({ where: { code } });
    if (existing && !options.rotateDeviceSecrets) {
      return { id: existing.id, code, credentials: null };
    }

    const credentials: DeviceCredentials = {
      secret: generateDeviceSecret(),
      pairingCode: generatePairingCode(),
      cameraSecret: generateDeviceSecret(),
      apPassword: generateApPassword(),
    };

    const configJson = {
      ...DEFAULT_DEVICE_CONFIG,
      // CL-0002 is the simulator, so it may emit DEMO-sourced fixes (§5.3.3).
      demoMode: code === 'CL-0002',
      cameraSecret: credentials.cameraSecret,
      apPassword: credentials.apPassword,
    } as unknown as Prisma.InputJsonValue;

    const data = {
      secretEnc: encryptSecret(credentials.secret, config.DEVICE_SECRET_KEY),
      pairingCodeHash: await bcrypt.hash(credentials.pairingCode, 10),
      config: configJson,
    };

    const device = await prisma.device.upsert({
      where: { code },
      create: { code, ...data },
      update: { ...data, revokedAt: null },
    });

    return { id: device.id, code, credentials };
  };

  const writeSecretsHeader = (device: SeededDevice): string | null => {
    if (!device.credentials) return null;
    const path = resolve(HERE, '../../../../firmware/main-esp32/include/secrets.h');

    const body = [
      '// Generated by the CrashLink seed. GITIGNORED - never commit.',
      '// Regenerated only when device secrets are rotated; re-flash the board then.',
      '#pragma once',
      '',
      `#define CL_DEVICE_CODE   "${device.code}"`,
      `#define CL_DEVICE_SECRET "${device.credentials.secret}"`,
      `#define CL_CAMERA_SECRET "${device.credentials.cameraSecret}"`,
      `#define CL_AP_PASSWORD   "${device.credentials.apPassword}"`,
      `#define CL_API_HOST      "${config.DEVICE_BASE_URL}"`,
      '',
    ].join('\n');

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
    return path;
  };

  /**
   * 14 days of synthetic history (§5.6.7): rentals, GPS traces and a spread of
   * INFO/SECURITY events plus three closed EMERGENCY incidents.
   *
   * All of it is `isDemo` and every incident type keeps its honest "Possible"
   * label - the seed does not manufacture a confirmed crash.
   */
  const seedHistory = async (input: {
    ownerId: string;
    driverId: string;
    contactId: string;
    bikes: { id: string; label: string }[];
    ownerPhone: string;
    driverName: string;
    driverPhone: string;
    contactName: string;
    contactPhone: string;
  }): Promise<void> => {
    const now = new Date();

    const bikeIds = input.bikes.map((bike) => bike.id);

    // Rebuild from scratch so re-seeding is a genuine reset, not an append.
    //
    // Open rentals (PENDING_SYNC / ACTIVE / ENDING_SYNC) are cleared too. Without
    // the device gateway nothing can ack a CLEAR_ASSIGNMENT, so a rental that
    // reaches ENDING_SYNC would otherwise pin the bike and the driver forever and
    // the next assignment would fail with DRIVER_BUSY (FR-RENT-02).
    await prisma.incident.deleteMany({ where: { ownerId: input.ownerId } });
    await prisma.locationSample.deleteMany({ where: { bikeId: { in: bikeIds } } });
    await prisma.ignitionEvent.deleteMany({ where: { bikeId: { in: bikeIds } } });
    await prisma.rental.deleteMany({ where: { ownerId: input.ownerId } });

    // Commands queued for the demo devices refer to rentals that no longer exist.
    await prisma.deviceCommand.deleteMany({
      where: { device: { bike: { id: { in: bikeIds } } } },
    });

    const infoTypes: IncidentType[] = ['POSSIBLE_POTHOLE', 'POSSIBLE_DANGEROUS_CORNERING'];
    const securityTypes: IncidentType[] = ['POSSIBLE_TOWING', 'POSSIBLE_TAMPERING', 'PARKED_BIKE_FALL'];
    const emergencyTypes: IncidentType[] = [
      'POSSIBLE_COLLISION',
      'POSSIBLE_LOW_SPEED_RIDER_DROP',
      'POSSIBLE_ROLLOVER',
    ];

    let assignmentVersion = 0;

    for (let dayAgo = 14; dayAgo >= 1; dayAgo -= 1) {
      const bike = input.bikes[dayAgo % input.bikes.length];
      if (!bike) continue;

      const startedAt = new Date(now.getTime() - dayAgo * DAY_MS + 9 * 3600_000);
      const endedAt = new Date(startedAt.getTime() + 75 * 60_000);
      assignmentVersion += 1;

      const rental = await prisma.rental.create({
        data: {
          bikeId: bike.id,
          driverId: input.driverId,
          ownerId: input.ownerId,
          emergencyContactId: input.contactId,
          ownerPhoneSnapshot: input.ownerPhone,
          driverNameSnapshot: input.driverName,
          driverPhoneSnapshot: input.driverPhone,
          contactNameSnapshot: input.contactName,
          contactPhoneSnapshot: input.contactPhone,
          state: 'ENDED',
          assignmentVersion,
          requestedAt: startedAt,
          deviceAckAt: startedAt,
          startedAt,
          endRequestedAt: endedAt,
          endedAt,
          distanceMeters: 3000 + ((dayAgo * 811) % 9000),
        },
      });

      // A short trace around Colombo so the map and distance charts have shape.
      const fixes = Array.from({ length: 12 }, (_, index) => ({
        bikeId: bike.id,
        rentalId: rental.id,
        fixAt: new Date(startedAt.getTime() + index * 5 * 60_000),
        lat: COLOMBO.lat + index * 0.0012 + dayAgo * 0.0004,
        lon: COLOMBO.lon + index * 0.0009 - dayAgo * 0.0003,
        speedKph: 12 + ((index * 7 + dayAgo) % 26),
        hdop: 1.1,
        satellites: 7,
        valid: true,
        source: 'GPS' as const,
      }));
      await prisma.locationSample.createMany({ data: fixes, skipDuplicates: true });

      // §5.6.5: riding/parked time is walked from ignition_events, so every
      // seeded ride leaves the ON/OFF pair a real one would. The last OFF also
      // carries into today, so the demo bikes read "parked", not "unknown".
      await prisma.ignitionEvent.createMany({
        data: [
          { bikeId: bike.id, rentalId: rental.id, state: 'ON', changedAt: startedAt },
          { bikeId: bike.id, rentalId: rental.id, state: 'OFF', changedAt: endedAt },
        ],
        skipDuplicates: true,
      });

      // ~20 INFO/SECURITY events across the fortnight.
      const eventCount = dayAgo % 3 === 0 ? 2 : 1;
      for (let n = 0; n < eventCount; n += 1) {
        const isSecurity = (dayAgo + n) % 4 === 0;
        const pool = isSecurity ? securityTypes : infoTypes;
        const type = pool[(dayAgo + n) % pool.length];
        if (!type) continue;

        const occurredAt = new Date(startedAt.getTime() + (20 + n * 17) * 60_000);
        const evidence = isSecurity
          ? { simulated: true, note: 'Seeded demo history' }
          : { simulated: true, peakAccelerationG: 1.8 + n * 0.2, durationMs: 220 };

        await prisma.incident.create({
          data: {
            id: crypto.randomUUID(),
            bikeId: bike.id,
            rentalId: isSecurity ? null : rental.id,
            driverId: isSecurity ? null : input.driverId,
            ownerId: input.ownerId,
            type,
            category: isSecurity ? 'SECURITY' : 'INFO',
            state: isSecurity ? 'CLOSED' : 'INFO_RECORDED',
            occurredAt,
            receivedAt: occurredAt,
            timeSource: 'GPS',
            ignitionAtEvent: isSecurity ? 'OFF' : 'ON',
            preEventSpeedKph: isSecurity ? null : 24,
            locationKind: 'LIVE',
            lat: COLOMBO.lat + dayAgo * 0.0005,
            lon: COLOMBO.lon + dayAgo * 0.0004,
            fixAt: occurredAt,
            fixAgeSec: 3,
            locationSource: 'GPS',
            evidence: evidence as Prisma.InputJsonValue,
            decision: 'NOT_APPLICABLE',
            ownerAckAt: isSecurity ? occurredAt : null,
            closedAt: isSecurity ? occurredAt : null,
            isDemo: true,
          },
        });
      }
    }

    // Three closed EMERGENCY incidents, one per outcome, so the incident screens
    // show a real spread: SAFE by the rider, HELP, and a server TIMEOUT.
    const outcomes = [
      { decision: 'SAFE' as const, source: 'APP' as const, state: 'CLOSED' as const },
      { decision: 'HELP' as const, source: 'APP' as const, state: 'CLOSED' as const },
      { decision: 'TIMEOUT' as const, source: 'SERVER_TIMER' as const, state: 'CLOSED' as const },
    ];

    for (const [index, outcome] of outcomes.entries()) {
      const bike = input.bikes[index % input.bikes.length];
      if (!bike) continue;

      const type = emergencyTypes[index] ?? 'POSSIBLE_COLLISION';
      const occurredAt = new Date(now.getTime() - (index + 2) * DAY_MS);
      const questionSentAt = new Date(occurredAt.getTime() + 3000);
      const deadlineAt = new Date(questionSentAt.getTime() + config.RESPONSE_WINDOW_SEC * 1000);
      const decidedAt =
        outcome.decision === 'TIMEOUT' ? deadlineAt : new Date(questionSentAt.getTime() + 14_000);

      const evidence = {
        fallenDurationMs: 10_000,
        peakAccelerationG: 2.4 + index * 0.4,
        peakRotationDps: 160 + index * 40,
        maxTiltDeg: 84,
        simulated: true,
      };

      const incident = await prisma.incident.create({
        data: {
          id: crypto.randomUUID(),
          bikeId: bike.id,
          ownerId: input.ownerId,
          driverId: input.driverId,
          type,
          category: 'EMERGENCY',
          state: outcome.state,
          severityScore: severityScore({ ...evidence, preEventSpeedKph: 24 }),
          occurredAt,
          receivedAt: questionSentAt,
          timeSource: 'GPS',
          ignitionAtEvent: 'ON',
          preEventSpeedKph: 24,
          locationKind: 'LIVE',
          lat: COLOMBO.lat + index * 0.002,
          lon: COLOMBO.lon + index * 0.002,
          fixAt: occurredAt,
          fixAgeSec: 2,
          locationSource: 'GPS',
          evidence: evidence as Prisma.InputJsonValue,
          ownerPhoneSnapshot: input.ownerPhone,
          driverNameSnapshot: input.driverName,
          contactNameSnapshot: input.contactName,
          contactPhoneSnapshot: input.contactPhone,
          serverQuestion: true,
          questionSentAt,
          responseDeadlineAt: deadlineAt,
          decision: outcome.decision,
          decisionSource: outcome.source,
          decidedAt,
          photoStatus: 'NOT_REQUESTED',
          ownerAckAt: new Date(decidedAt.getTime() + 300_000),
          ownerNote: 'Seeded demo history',
          closedAt: new Date(decidedAt.getTime() + 300_000),
          isDemo: true,
        },
      });

      // §5.3.7: the owner SMS only ever reached AT_SUBMITTED - the modem returned
      // +CMGS. The seed does not claim delivery it cannot prove.
      await prisma.notification.create({
        data: {
          incidentId: incident.id,
          kind: 'OWNER_SMS',
          state: 'AT_SUBMITTED',
          recipientMasked: `+94•••••${input.ownerPhone.slice(-4)}`,
          attempts: {
            create: { attemptNo: 1, state: 'AT_SUBMITTED', detail: '+CMGS: 23', deviceTime: questionSentAt },
          },
        },
      });

      if (outcome.decision !== 'SAFE') {
        await prisma.notification.create({
          data: {
            incidentId: incident.id,
            kind: 'CONTACT_SMS',
            state: 'AT_SUBMITTED',
            recipientMasked: `+94•••••${input.contactPhone.slice(-4)}`,
            attempts: {
              create: { attemptNo: 1, state: 'AT_SUBMITTED', detail: '+CMGS: 24', deviceTime: decidedAt },
            },
          },
        });
      }

      if (outcome.decision === 'SAFE' || outcome.decision === 'HELP') {
        await prisma.driverResponse.create({
          data: {
            incidentId: incident.id,
            choice: outcome.decision,
            source: 'APP',
            responderUserId: input.driverId,
            idempotencyKey: crypto.randomUUID(),
            serverReceivedAt: decidedAt,
            accepted: true,
          },
        });
      }
    }
  };

  // -------------------------------------------------------------------------

  const adminPassword = config.ADMIN_SEED_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_SEED_PASSWORD must be set before seeding (Appendix B).');
  }

  await upsertUser({
    role: 'ADMIN',
    name: 'CrashLink Admin',
    email: DEMO_ACCOUNTS.admin,
    phone: null,
    password: adminPassword,
    isDemo: false,
  });

  for (const [key, legacy] of Object.entries(LEGACY_DEMO_EMAILS) as [keyof typeof DEMO_ACCOUNTS, string][]) {
    const target = DEMO_ACCOUNTS[key];
    const [old, taken] = await Promise.all([
      prisma.user.findUnique({ where: { email: legacy }, select: { id: true } }),
      prisma.user.findUnique({ where: { email: target }, select: { id: true } }),
    ]);
    if (old && !taken) await prisma.user.update({ where: { id: old.id }, data: { email: target } });
  }

  // Fixed demo logins: M11 removed password reset, so the team must be able to
  // sign in without one.
  const owner = await upsertUser({
    role: 'OWNER',
    name: DEMO_PEOPLE.owner,
    email: DEMO_ACCOUNTS.owner,
    phone: DEMO.ownerPhone,
    password: 'demo1234',
    isDemo: true,
  });

  const driver = await upsertUser({
    role: 'DRIVER',
    name: DEMO_PEOPLE.driver,
    email: DEMO_ACCOUNTS.driver,
    phone: DEMO.driverPhone,
    password: 'demo1234',
    isDemo: true,
  });

  await upsertUser({
    role: 'GUEST',
    name: 'Judge (read-only)',
    email: DEMO_ACCOUNTS.guest,
    phone: null,
    password: 'demo1234',
    isDemo: true,
  });

  // FR-DRV-01: exactly one current contact per driver (§5.6.3). Reuse the
  // current one when it is already the demo contact, so re-seeding does not
  // pile up retired rows.
  const current = await prisma.emergencyContact.findFirst({
    where: { driverId: driver.id, isCurrent: true },
  });
  const contact =
    current && current.phoneE164 === DEMO.contactPhone && current.name === DEMO_PEOPLE.contact
      ? current
      : await prisma.$transaction(async (tx) => {
          await tx.emergencyContact.updateMany({
            where: { driverId: driver.id, isCurrent: true },
            data: { isCurrent: false },
          });
          return tx.emergencyContact.create({
            data: {
              driverId: driver.id,
              name: DEMO_PEOPLE.contact,
              phoneE164: DEMO.contactPhone,
              relationship: DEMO_PEOPLE.contactRelationship,
              isCurrent: true,
            },
          });
        });

  const deviceOne = await seedDevice('CL-0001');
  const deviceTwo = await seedDevice('CL-0002');

  const bikeOne = await prisma.bike.upsert({
    where: { deviceId: deviceOne.id },
    create: {
      ownerId: owner.id,
      deviceId: deviceOne.id,
      label: 'Scooter 1',
      plateNo: 'WP BCD-1234',
      status: 'AVAILABLE',
      isDemo: true,
    },
    update: { ownerId: owner.id, label: 'Scooter 1', status: 'AVAILABLE', isDemo: true },
  });

  const bikeTwo = await prisma.bike.upsert({
    where: { deviceId: deviceTwo.id },
    create: {
      ownerId: owner.id,
      deviceId: deviceTwo.id,
      label: 'Scooter 2',
      plateNo: 'WP BCD-5678',
      status: 'AVAILABLE',
      isDemo: true,
    },
    update: { ownerId: owner.id, label: 'Scooter 2', status: 'AVAILABLE', isDemo: true },
  });

  await seedHistory({
    ownerId: owner.id,
    driverId: driver.id,
    contactId: contact.id,
    bikes: [
      { id: bikeOne.id, label: bikeOne.label },
      { id: bikeTwo.id, label: bikeTwo.label },
    ],
    ownerPhone: DEMO.ownerPhone,
    driverName: driver.name,
    driverPhone: DEMO.driverPhone,
    contactName: contact.name,
    contactPhone: contact.phoneE164,
  });

  // FR-INC-11: no incident exists without an integrity hash - seeded history
  // included - so the detail screen can verify demo data like real data.
  const seeded = await prisma.incident.findMany({ where: { ownerId: owner.id }, select: { id: true } });
  for (const { id } of seeded) await stampIntegrityHash(prisma, id, null);

  // The bike's current ignition must agree with its last recorded event, or
  // "parked for X min" and today's parked time would contradict each other.
  for (const bike of [bikeOne, bikeTwo]) {
    const last = await prisma.ignitionEvent.findFirst({
      where: { bikeId: bike.id },
      orderBy: { changedAt: 'desc' },
    });
    if (last) {
      await prisma.bike.update({
        where: { id: bike.id },
        data: { ignition: last.state, ignitionChangedAt: last.changedAt },
      });
    }
  }

  const secretsPath = options.writeSecretsHeader === false ? null : writeSecretsHeader(deviceOne);

  return {
    ownerId: owner.id,
    bikeIds: [bikeOne.id, bikeTwo.id],
    devices: [deviceOne, deviceTwo],
    secretsPath,
    incidents: seeded.length,
  };
};
