/**
 * §4.3 workers - in-process loops driven by DB state, so a restart loses
 * nothing: every worker recomputes what is due from the rows themselves rather
 * than from in-memory timers.
 *
 * `deadlineWorker` (1 s), `deadManWorker` (15 s), `commandExpiryWorker` (30 s),
 * `retentionWorker` (daily).
 *
 * Tests drive `runOnce()` directly with a fake clock instead of waiting on real
 * intervals, which is why each worker separates "one pass" from "the loop".
 */
import type { PrismaClient } from '@prisma/client';
import type { Clock } from '../lib/time.js';
import type { Config } from '../config.js';
import type { DeviceIngestService } from '../modules/devices/ingest.service.js';
import type { DecisionService } from '../modules/incidents/decision.service.js';
import { runDeadlinePass } from './deadline.js';
import { runDeadManPass } from './deadMan.js';
import { runCommandExpiryPass } from './commandExpiry.js';
import { runRetentionPass } from './retention.js';

export interface WorkerDeps {
  prisma: PrismaClient;
  clock: Clock;
  config: Config;
  decisions: DecisionService;
  ingest: DeviceIngestService;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface WorkerStatus {
  lastRunAt: Date | null;
  lagMs: number | null;
  lastError: string | null;
}

interface WorkerSpec {
  name: string;
  intervalMs: number;
  run: (deps: WorkerDeps) => Promise<number>;
}

const SPECS: WorkerSpec[] = [
  { name: 'deadline', intervalMs: 1_000, run: runDeadlinePass },
  { name: 'deadMan', intervalMs: 15_000, run: runDeadManPass },
  { name: 'commandExpiry', intervalMs: 30_000, run: runCommandExpiryPass },
  { name: 'retention', intervalMs: 24 * 60 * 60 * 1_000, run: runRetentionPass },
];

/**
 * Owns the interval handles and the status each worker reports to
 * `/admin/health` (FR-ADM-01).
 */
export class WorkerRunner {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly status = new Map<string, WorkerStatus>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {
    for (const spec of SPECS) {
      this.status.set(spec.name, { lastRunAt: null, lagMs: null, lastError: null });
    }
  }

  /** One pass of one worker. Exposed so tests can step time deterministically. */
  async runOnce(name: string): Promise<number> {
    const spec = SPECS.find((candidate) => candidate.name === name);
    if (!spec) throw new Error(`Unknown worker: ${name}`);
    return this.execute(spec);
  }

  private async execute(spec: WorkerSpec): Promise<number> {
    // A slow pass must not overlap itself; skipping is correct because the next
    // tick recomputes what is still due from the database.
    if (this.running.has(spec.name)) return 0;
    this.running.add(spec.name);

    const startedAt = Date.now();
    try {
      const affected = await spec.run(this.deps);
      this.status.set(spec.name, {
        lastRunAt: this.deps.clock.now(),
        lagMs: Date.now() - startedAt,
        lastError: null,
      });
      return affected;
    } catch (error) {
      // A worker must never die: the next tick tries again.
      this.status.set(spec.name, {
        lastRunAt: this.deps.clock.now(),
        lagMs: Date.now() - startedAt,
        lastError: (error as Error).message,
      });
      this.deps.log(`worker ${spec.name} failed`, { error: (error as Error).message });
      return 0;
    } finally {
      this.running.delete(spec.name);
    }
  }

  start(): void {
    for (const spec of SPECS) {
      // Run once immediately. Otherwise the daily retention worker has no
      // lastRunAt for a day and /admin/health (and demo:check) cannot tell a
      // healthy worker from a dead one. Every pass is idempotent, so this is safe.
      void this.execute(spec);
      const timer = setInterval(() => void this.execute(spec), spec.intervalMs);
      // Do not hold the event loop open on shutdown.
      timer.unref();
      this.timers.push(timer);
    }
    this.deps.log('workers started', { workers: SPECS.map((spec) => spec.name) });
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /**
   * FR-ADM-01 `/admin/health`. `lagMs` is how long the last pass took;
   * staleness (how overdue the next one is) is `now - lastRunAt` against
   * `intervalMs`, which demo:check judges.
   */
  snapshot(): Record<
    string,
    { lastRunAt: string | null; lagMs: number | null; intervalMs: number; lastError: string | null }
  > {
    const result: Record<
      string,
      { lastRunAt: string | null; lagMs: number | null; intervalMs: number; lastError: string | null }
    > = {};
    for (const spec of SPECS) {
      const status = this.status.get(spec.name);
      result[spec.name] = {
        lastRunAt: status?.lastRunAt ? status.lastRunAt.toISOString() : null,
        lagMs: status?.lagMs ?? null,
        intervalMs: spec.intervalMs,
        lastError: status?.lastError ?? null,
      };
    }
    return result;
  }
}
