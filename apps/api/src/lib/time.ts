/**
 * Time helpers. Storage and transport are UTC everywhere (CLAUDE.md); display
 * in Asia/Colombo happens in the app and in SMS text built by the firmware.
 *
 * Every deadline-sensitive code path reads `now()` from an injectable clock so
 * tests can use a fake clock (§4.3 testing row).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock the tests can advance by hand. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string = '2026-09-21T06:30:00.000Z') {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export const addSeconds = (at: Date, seconds: number): Date =>
  new Date(at.getTime() + seconds * 1000);

export const addDays = (at: Date, days: number): Date => addSeconds(at, days * 86400);

/** UTC ISO-8601 with Z and milliseconds, the shape every DTO uses. */
export const toIso = (at: Date | null | undefined): string | null =>
  at ? new Date(at).toISOString() : null;

export const toIsoRequired = (at: Date): string => new Date(at).toISOString();

export const secondsBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / 1000);
