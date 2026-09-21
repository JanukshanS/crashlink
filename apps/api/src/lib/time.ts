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

// ---------------------------------------------------------------------------
// Local-day helpers (storage is UTC; days are counted in TZ_DISPLAY)
// ---------------------------------------------------------------------------

/**
 * Milliseconds the given zone is ahead of UTC at `at`. Derived from Intl so a
 * zone with DST would also work, although Asia/Colombo has none.
 */
export const zoneOffsetMs = (at: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - (at.getTime() - at.getUTCMilliseconds());
};

/** `YYYY-MM-DD` of `at` as a person in `timeZone` would read it. */
export const zonedDateKey = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

/** The UTC instant of local midnight at the start of `at`'s day in `timeZone`. */
export const zonedDayStart = (at: Date, timeZone: string): Date => {
  const [year, month, day] = zonedDateKey(at, timeZone).split('-').map(Number) as [number, number, number];
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  // Refine once with the offset in force at the guess itself, in case the day
  // started under a different offset than `at` (DST); a no-op for Colombo.
  const guess = midnightAsUtc - zoneOffsetMs(at, timeZone);
  return new Date(midnightAsUtc - zoneOffsetMs(new Date(guess), timeZone));
};

/** Calendar arithmetic on a `YYYY-MM-DD` key, independent of any time zone. */
export const addDaysToKey = (key: string, days: number): string => {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
