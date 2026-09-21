/**
 * Pre-demo checklist rules (`npm run demo:check`).
 *
 * Pure functions: facts in, green / yellow / red out. Kept apart from the CLI
 * so every threshold is unit-tested - a checklist that says green when the
 * deadline worker is dead is worse than no checklist.
 *
 *   green  ready
 *   yellow works, but look at it (or: skipped because it does not apply)
 *   red    will hurt the demo - fix before going on stage
 */
export type CheckStatus = 'green' | 'yellow' | 'red';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const fmtAge = (sec: number): string => {
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${(sec / 3600).toFixed(1)} h ago`;
};

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export interface WorkerFact {
  name: string;
  lastRunAt: string | null;
  intervalMs: number;
  lastError: string | null;
}

/**
 * A worker is judged by how overdue it is, relative to its own interval. The
 * deadline worker (1 s) being 30 s late is a missed TIMEOUT; the retention
 * worker (daily) being an hour late is nothing.
 */
export const classifyWorker = (worker: WorkerFact, serverNow: Date): CheckResult => {
  const name = `worker ${worker.name}`;

  if (worker.lastError) {
    return { name, status: 'red', detail: `last pass failed: ${worker.lastError}` };
  }
  if (!worker.lastRunAt) {
    return { name, status: 'red', detail: 'has never run - is the API running with workers enabled?' };
  }

  const ageMs = serverNow.getTime() - Date.parse(worker.lastRunAt);
  const age = fmtAge(ageMs / 1000);

  // Allowance for the pass itself plus scheduling jitter.
  const greenMs = Math.max(worker.intervalMs * 3, 5_000);
  const yellowMs = Math.max(worker.intervalMs * 10, 30_000);

  if (ageMs <= greenMs) return { name, status: 'green', detail: `ran ${age}` };
  if (ageMs <= yellowMs) return { name, status: 'yellow', detail: `ran ${age} - running late` };
  return { name, status: 'red', detail: `ran ${age} - stalled` };
};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceFact {
  code: string;
  bikeLabel: string;
  online: 'ONLINE' | 'STALE' | 'OFFLINE';
  lastSeenAt: string | null;
  /** Config `demoMode` - the simulator, which is normally off until needed. */
  simulator: boolean;
  revoked: boolean;
}

export const classifyDevice = (device: DeviceFact, serverNow: Date): CheckResult => {
  const name = `device ${device.code} (${device.bikeLabel})`;
  const seen = device.lastSeenAt
    ? `last seen ${fmtAge((serverNow.getTime() - Date.parse(device.lastSeenAt)) / 1000)}`
    : 'never reported';

  if (device.revoked) return { name, status: 'red', detail: 'REVOKED - every request gets 401' };
  if (device.online === 'ONLINE') return { name, status: 'green', detail: `online, ${seen}` };
  if (device.online === 'STALE') return { name, status: 'yellow', detail: `stale, ${seen}` };

  // The simulator is started on demand; real hardware must be up.
  return device.simulator
    ? { name, status: 'yellow', detail: `offline, ${seen} - start the simulator when needed` }
    : { name, status: 'red', detail: `OFFLINE, ${seen} - power the bike and check GPRS` };
};

// ---------------------------------------------------------------------------
// Pending commands
// ---------------------------------------------------------------------------

export interface CommandFact {
  deviceCode: string;
  type: string;
  ageSec: number;
}

/** A command older than this is not "in flight" - the device is not taking it. */
export const STUCK_COMMAND_SEC = 120;

export const classifyCommands = (commands: CommandFact[]): CheckResult => {
  const name = 'pending device commands';
  if (commands.length === 0) return { name, status: 'green', detail: 'none queued' };

  const stuck = commands.filter((command) => command.ageSec > STUCK_COMMAND_SEC);
  if (stuck.length > 0) {
    const worst = [...stuck].sort((a, b) => b.ageSec - a.ageSec)[0]!;
    return {
      name,
      status: 'red',
      detail: `${stuck.length} stuck - e.g. ${worst.deviceCode} ${worst.type} queued ${fmtAge(worst.ageSec)}`,
    };
  }
  return { name, status: 'yellow', detail: `${commands.length} in flight (under ${STUCK_COMMAND_SEC} s old)` };
};

// ---------------------------------------------------------------------------
// TLS certificate
// ---------------------------------------------------------------------------

export type CertFact =
  | { kind: 'not-https'; url: string }
  | { kind: 'error'; host: string; message: string }
  | { kind: 'ok'; host: string; validTo: Date };

export const classifyCert = (cert: CertFact, now: Date): CheckResult => {
  const name = 'TLS certificate';
  if (cert.kind === 'not-https') {
    return { name, status: 'yellow', detail: `skipped - PUBLIC_BASE_URL is not https (${cert.url})` };
  }
  if (cert.kind === 'error') {
    return { name, status: 'red', detail: `could not read the certificate for ${cert.host}: ${cert.message}` };
  }

  const days = (cert.validTo.getTime() - now.getTime()) / 86_400_000;
  const when = `${cert.host} expires ${cert.validTo.toISOString().slice(0, 10)}`;
  if (days < 0) return { name, status: 'red', detail: `EXPIRED - ${when}` };
  if (days < 3) return { name, status: 'red', detail: `${Math.floor(days)} days left - ${when}` };
  if (days < 14) return { name, status: 'yellow', detail: `${Math.floor(days)} days left - ${when}` };
  return { name, status: 'green', detail: `${Math.floor(days)} days left - ${when}` };
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface Summary {
  ready: boolean;
  green: number;
  yellow: number;
  red: number;
}

/** Ready means nothing red. Yellows are warnings, not blockers. */
export const summarize = (checks: CheckResult[]): Summary => {
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  const red = count('red');
  return { ready: red === 0, green: count('green'), yellow: count('yellow'), red };
};
