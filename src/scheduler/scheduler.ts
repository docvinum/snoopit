/**
 * Deciding which jobs should run now.
 *
 * The scheduler answers one question — *what is due?* — and answers it from
 * recorded state plus a pure function of the clock. It starts nothing itself; the
 * caller does. That separation is what lets the whole decision be unit-tested
 * without a browser, a database write, or a wait.
 */

import type { Store } from '../state/store.js';
import type { Job } from '../state/types.js';
import { isDue, pagesForRun, type DueVerdict } from './window.js';

export interface SchedulerOptions {
  readonly now?: Date;
  /**
   * Zone in which schedule windows are interpreted for jobs that do not name their
   * own (`schedule.timeZone`). Defaults to UTC.
   */
  readonly timeZone?: string;
}

export interface JobDecision {
  readonly job: Job;
  readonly verdict: DueVerdict;
  /** Frontier entries this run may claim, or `null` when unbounded. */
  readonly pagesPerRun: number | null;
}

/** Evaluates every enabled job, due or not. Useful for `snoopit due`. */
export function evaluateJobs(store: Store, options: SchedulerOptions = {}): JobDecision[] {
  const now = options.now ?? new Date();
  const defaultZone = options.timeZone ?? 'UTC';

  return store.jobs.list({ enabledOnly: true }).map((job) => {
    const schedule = job.schedule ?? { frequency: 'manual' as const };
    // The job's own zone wins: it is part of what the schedule means.
    const timeZone = schedule.timeZone ?? defaultZone;
    const latest = store.runs.latestForJob(job.id);

    const verdict = isDue({
      schedule,
      jobId: job.id,
      now,
      lastRunAt: latest === null ? null : new Date(latest.startedAt),
      timeZone,
    });

    return {
      job,
      verdict,
      pagesPerRun: pagesForRun(schedule, job.id, verdict.periodKey),
    };
  });
}

/** The jobs that should start a run now. */
export function dueJobs(store: Store, options: SchedulerOptions = {}): JobDecision[] {
  return evaluateJobs(store, options).filter((decision) => decision.verdict.due);
}
