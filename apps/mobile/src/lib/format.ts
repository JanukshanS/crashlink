/** Display formatting. Storage is UTC; everything shown is Asia/Colombo. */

export const DISPLAY_TZ = 'Asia/Colombo';

/** "1 h 12 min", "45 min", "30 s" - the unit that is easiest to read at a glance. */
export const formatDuration = (totalSec: number): string => {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec} s`;

  const minutes = Math.floor(sec / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/** "21 Sep" for a `YYYY-MM-DD` day key, without a time-zone shift. */
export const formatDayKey = (key: string): string => {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
};

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: DISPLAY_TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const formatKm = (metres: number): string => {
  const km = metres / 1000;
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
};

/**
 * §5.6.5 severity is a crash heuristic. It applies when there is a score, or
 * for SOS (which has none by definition). A towing alert or a pothole has no
 * severity, and showing "LOW" for it would state something untrue.
 */
export const severityApplies = (severity: { score: number | null; label: string }): boolean =>
  severity.score !== null || severity.label === 'SOS';
