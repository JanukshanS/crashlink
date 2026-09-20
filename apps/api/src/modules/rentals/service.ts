/**
 * §5.4.5 / FR-RENT-01..04 - rental assignment and lifecycle.
 *
 * Two things in here must be exactly right (§4.3 "Business-logic core"):
 *
 * 1. **Invariants.** At most one open rental per bike and per driver. The
 *    in-transaction checks below produce friendly errors, but the *real* guard
 *    is the pair of partial unique indexes from §5.6.3 - they are what holds
 *    under two concurrent assignments, and plugins/errors.ts translates the
 *    resulting P2002 into RENTAL_ACTIVE_EXISTS / DRIVER_BUSY.
 *
 * 2. **Snapshots.** Owner phone, driver name/phone and contact name/phone are
 *    copied onto the rental row at assignment and never updated afterwards
 *    (§5.6.4). The bike sends SMS to the numbers it was given when the ride
 *    started; a contact edited mid-rental applies to the next one (FR-DRV-04).
 */
import type { Prisma, PrismaClient, Rental } from '@prisma/client';
import {
  COMMAND_TTL_SEC,
  type CreateRentalResponse,
  OPEN_RENTAL_STATES,
  type SetAssignmentPayload,
  maskPhone,
} from '@crashlink/contracts';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { addSeconds, toIso, toIsoRequired, type Clock } from '../../lib/time.js';

export interface RentalServiceDeps {
  prisma: PrismaClient;
  clock: Clock;
  demoMode: boolean;
}

export interface AssignInput {
  bikeId: string;
  driverId: string;
  idempotencyKey: string;
}

/** The §5.6.3 "open rental" set, as a Prisma filter. */
const openStateFilter: Prisma.EnumRentalStateFilter = { in: [...OPEN_RENTAL_STATES] };

export class RentalService {
  constructor(private readonly deps: RentalServiceDeps) {}

  /**
   * §5.4.1 idempotency: a retried mutation returns the first result rather than
   * creating a second rental. Records are keyed by the client's UUID and kept
   * for 24 h.
   */
  private async replay(key: string, route: string): Promise<unknown | null> {
    const record = await this.deps.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return null;
    if (record.route !== route) {
      throw conflict('CONFLICT', 'That idempotency key was already used for a different request.');
    }
    return record.response;
  }

  /** FR-RENT-01. */
  async assign(ownerId: string, input: AssignInput): Promise<CreateRentalResponse> {
    const { prisma, clock } = this.deps;
    const route = 'POST /rentals';

    const replayed = await this.replay(input.idempotencyKey, route);
    if (replayed) return replayed as CreateRentalResponse;

    const now = clock.now();

    return prisma.$transaction(async (tx) => {
      // Ownership scoping: another owner's bike is a 404, not a 403 (§5.7.2).
      const bike = await tx.bike.findFirst({
        where: { id: input.bikeId, ownerId },
        include: { device: { select: { id: true, revokedAt: true } } },
      });
      if (!bike) throw notFound('Bike');

      // FR-RENT-01: a bike with no device cannot carry a rental - there would
      // be nothing to detect a crash or send the SMS.
      if (!bike.deviceId || !bike.device) {
        throw conflict('DEVICE_NOT_PAIRED', 'Pair a device to this bike before assigning a driver.');
      }
      if (bike.device.revokedAt) {
        throw conflict('DEVICE_NOT_PAIRED', 'This bike has a revoked device. Re-provision it first.');
      }

      const owner = await tx.user.findUnique({
        where: { id: ownerId },
        select: { id: true, phoneE164: true },
      });
      // The owner SMS recipient is part of the snapshot, so it must exist now.
      // TODO(spec): §5.4.5 lists no code for "owner has no phone"; CONFLICT is
      // the safest fit and the message says exactly what to fix.
      if (!owner?.phoneE164) {
        throw conflict('CONFLICT', 'Add a phone number to your account before assigning a driver.');
      }

      const driver = await tx.user.findFirst({
        where: { id: input.driverId, role: 'DRIVER', disabledAt: null },
        select: { id: true, name: true, phoneE164: true },
      });
      if (!driver) throw notFound('Driver');

      // FR-RENT-01: a driver with no current emergency contact cannot be
      // assigned - the whole escalation path depends on that number.
      const contact = await tx.emergencyContact.findFirst({
        where: { driverId: driver.id, isCurrent: true },
      });
      if (!contact) {
        throw conflict('NO_EMERGENCY_CONTACT', 'This driver has not set an emergency contact yet.');
      }

      // FR-RENT-02 friendly path. The DB indexes remain the authority.
      const bikeBusy = await tx.rental.findFirst({
        where: { bikeId: bike.id, state: openStateFilter },
        select: { id: true },
      });
      if (bikeBusy) throw conflict('RENTAL_ACTIVE_EXISTS', 'Bike already has an open rental.');

      const driverBusy = await tx.rental.findFirst({
        where: { driverId: driver.id, state: openStateFilter },
        select: { id: true },
      });
      if (driverBusy) throw conflict('DRIVER_BUSY', 'Driver already has an open rental.');

      // §5.6.4: next version = max + 1, inside this transaction.
      const previous = await tx.rental.aggregate({
        where: { bikeId: bike.id },
        _max: { assignmentVersion: true },
      });
      const assignmentVersion = (previous._max.assignmentVersion ?? 0) + 1;

      const rental = await tx.rental.create({
        data: {
          bikeId: bike.id,
          driverId: driver.id,
          ownerId,
          emergencyContactId: contact.id,
          ownerPhoneSnapshot: owner.phoneE164,
          driverNameSnapshot: driver.name,
          driverPhoneSnapshot: driver.phoneE164,
          contactNameSnapshot: contact.name,
          contactPhoneSnapshot: contact.phoneE164,
          state: 'PENDING_SYNC',
          assignmentVersion,
          requestedAt: now,
        },
      });

      // §5.3.4: the device persists this snapshot in NVS and only then acks,
      // which is what moves the rental PENDING_SYNC -> ACTIVE (FR-RENT-03).
      const payload: SetAssignmentPayload = {
        rentalId: rental.id,
        assignmentVersion,
        bikeLabel: bike.label,
        ownerPhone: owner.phoneE164,
        driverName: driver.name,
        driverPhone: driver.phoneE164,
        contactName: contact.name,
        contactPhone: contact.phoneE164,
      };

      await tx.deviceCommand.create({
        data: {
          deviceId: bike.deviceId,
          type: 'SET_ASSIGNMENT',
          payload: payload as unknown as Prisma.InputJsonValue,
          status: 'QUEUED',
          expiresAt: addSeconds(now, COMMAND_TTL_SEC),
        },
      });

      await tx.bike.update({ where: { id: bike.id }, data: { status: 'RENTED' } });

      // §5.7.3: rental assignment is audited, with the phone masked.
      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: ownerId,
          action: 'RENTAL_ASSIGNED',
          targetType: 'RENTAL',
          targetId: rental.id,
          meta: {
            bikeId: bike.id,
            driverId: driver.id,
            assignmentVersion,
            contactPhoneMasked: maskPhone(contact.phoneE164),
          },
        },
      });

      const response: CreateRentalResponse = {
        id: rental.id,
        state: 'PENDING_SYNC',
        assignmentVersion,
        snapshot: {
          driverName: rental.driverNameSnapshot,
          contactName: rental.contactNameSnapshot,
          // Masked even for the owner here: this response is rendered in a list.
          contactPhoneMasked: maskPhone(rental.contactPhoneSnapshot) ?? '',
        },
      };

      await tx.idempotencyRecord.create({
        data: {
          key: input.idempotencyKey,
          userId: ownerId,
          route,
          statusCode: 201,
          response: response as unknown as Prisma.InputJsonValue,
        },
      });

      return response;
    });
  }

  /** §5.4.5 cancel - PENDING_SYNC only; the ride never started. */
  async cancel(ownerId: string, rentalId: string): Promise<{ state: 'CANCELLED' }> {
    const { prisma, clock } = this.deps;
    const now = clock.now();

    return prisma.$transaction(async (tx) => {
      const rental = await tx.rental.findFirst({
        where: { id: rentalId, ownerId },
        include: { bike: { select: { id: true, deviceId: true } } },
      });
      if (!rental) throw notFound('Rental');

      if (rental.state === 'CANCELLED') return { state: 'CANCELLED' as const };
      if (rental.state !== 'PENDING_SYNC') {
        throw conflict('CONFLICT', `A rental in state ${rental.state} cannot be cancelled.`);
      }

      await tx.rental.update({ where: { id: rental.id }, data: { state: 'CANCELLED' } });

      // The device must not later apply an assignment the owner cancelled.
      if (rental.bike.deviceId) {
        await tx.deviceCommand.updateMany({
          where: {
            deviceId: rental.bike.deviceId,
            type: 'SET_ASSIGNMENT',
            status: { in: ['QUEUED', 'DELIVERED'] },
          },
          data: { status: 'EXPIRED', expiresAt: now },
        });
      }

      await tx.bike.update({ where: { id: rental.bikeId }, data: { status: 'AVAILABLE' } });

      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: ownerId,
          action: 'RENTAL_CANCELLED',
          targetType: 'RENTAL',
          targetId: rental.id,
          meta: {},
        },
      });

      return { state: 'CANCELLED' as const };
    });
  }

  /**
   * FR-RENT-04 end. The rental goes to ENDING_SYNC and a CLEAR_ASSIGNMENT is
   * queued; only the device ack moves it to ENDED, so the UI can be honest
   * about whether the bike has actually let go of the rider's details.
   */
  async end(ownerId: string, rentalId: string, idempotencyKey: string): Promise<{ state: 'ENDING_SYNC' }> {
    const { prisma, clock } = this.deps;
    const route = 'POST /rentals/:id/end';

    const replayed = await this.replay(idempotencyKey, route);
    if (replayed) return replayed as { state: 'ENDING_SYNC' };

    const now = clock.now();

    return prisma.$transaction(async (tx) => {
      const rental = await tx.rental.findFirst({
        where: { id: rentalId, ownerId },
        include: { bike: { select: { id: true, deviceId: true } } },
      });
      if (!rental) throw notFound('Rental');

      if (rental.state === 'ENDING_SYNC') return { state: 'ENDING_SYNC' as const };

      // PENDING_SYNC is cancelled, not ended (§4.5.3): the device never had it.
      if (rental.state !== 'ACTIVE') {
        throw conflict(
          'CONFLICT',
          rental.state === 'PENDING_SYNC'
            ? 'This rental has not started yet - cancel it instead.'
            : `A rental in state ${rental.state} cannot be ended.`,
        );
      }

      await tx.rental.update({
        where: { id: rental.id },
        data: { state: 'ENDING_SYNC', endRequestedAt: now },
      });

      if (rental.bike.deviceId) {
        await tx.deviceCommand.create({
          data: {
            deviceId: rental.bike.deviceId,
            type: 'CLEAR_ASSIGNMENT',
            payload: {
              rentalId: rental.id,
              assignmentVersion: rental.assignmentVersion,
            } as Prisma.InputJsonValue,
            status: 'QUEUED',
            expiresAt: addSeconds(now, COMMAND_TTL_SEC),
          },
        });
      }

      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: ownerId,
          action: 'RENTAL_END_REQUESTED',
          targetType: 'RENTAL',
          targetId: rental.id,
          meta: { assignmentVersion: rental.assignmentVersion },
        },
      });

      const response = { state: 'ENDING_SYNC' as const };

      await tx.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          userId: ownerId,
          route,
          statusCode: 200,
          response: response as unknown as Prisma.InputJsonValue,
        },
      });

      return response;
    });
  }

  /**
   * FR-RENT-03 demo force-activate. Allowed only when DEMO_MODE=true, always
   * audit-logged, and the rental carries `demoOverride` so every screen showing
   * it can say the bike never actually confirmed.
   */
  async forceActivate(
    ownerId: string,
    rentalId: string,
  ): Promise<{ state: 'ACTIVE'; demoOverride: true }> {
    const { prisma, clock } = this.deps;

    if (!this.deps.demoMode) {
      throw forbidden('Force-activate is only available when DEMO_MODE is enabled.');
    }

    const now = clock.now();

    return prisma.$transaction(async (tx) => {
      const rental = await tx.rental.findFirst({ where: { id: rentalId, ownerId } });
      if (!rental) throw notFound('Rental');

      if (rental.state === 'ACTIVE') {
        return { state: 'ACTIVE' as const, demoOverride: true as const };
      }
      if (rental.state !== 'PENDING_SYNC') {
        throw conflict('CONFLICT', `A rental in state ${rental.state} cannot be activated.`);
      }

      await tx.rental.update({
        where: { id: rental.id },
        data: { state: 'ACTIVE', demoOverride: true, startedAt: now },
      });

      await tx.auditEvent.create({
        data: {
          actorType: 'USER',
          actorId: ownerId,
          action: 'RENTAL_FORCE_ACTIVATED',
          targetType: 'RENTAL',
          targetId: rental.id,
          meta: { demoOverride: true, reason: 'DEMO_MODE override, device never acked' },
        },
      });

      return { state: 'ACTIVE' as const, demoOverride: true as const };
    });
  }
}

/** §5.4.5 list row. */
export const toRentalSummary = (
  rental: Rental & { bike: { label: string }; driver: { name: string } },
) => ({
  id: rental.id,
  bikeId: rental.bikeId,
  bikeLabel: rental.bike.label,
  driverId: rental.driverId,
  driverName: rental.driver.name,
  state: rental.state,
  assignmentVersion: rental.assignmentVersion,
  demoOverride: rental.demoOverride,
  requestedAt: toIsoRequired(rental.requestedAt),
  startedAt: toIso(rental.startedAt),
  endedAt: toIso(rental.endedAt),
  distanceM: rental.distanceMeters,
});
