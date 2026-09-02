/**
 * When is a job due?
 *
 * Two ideas carry this module.
 *
 * **Periods.** A schedule fires at most once per period — per clock hour, per
 * calendar day, per ISO week. "Has a run already happened this period?" is a
 * question about recorded state, not about elapsed time since the last run, so a
 * scheduler restart or a manual run cannot cause a double fire.
 *
 * **Deterministic jitter.** Inside a window, the exact moment is derived from the
 * job id and the period key. It is therefore stable — asking twice in the same
 * period gives the same answer, so a job does not drift earlier every time the
 * scheduler wakes — while different jobs spread across the window instead of all
 * firing at its first second.
 *
 * That is what jitter is for here: distributing load and giving execution some
 * slack. It is not, and must not become, a way to disguise access patterns from a
 * site that has asked us to slow down (spec §9).
 *
 * Everything is pure: given a schedule, a job id and an instant, the answer is
 * fixed. That is what makes the scheduler testable without waiting for a clock.
 */

import { createHash } from 'node:crypto';
import { parseClockTime } from '../util/time.js';
import type { JobSchedule } from '../state/types.js';

const MINUTES_PER_DAY = 24 * 60;

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 1 = Monday .. 7 = Sunday. */
  readonly weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Wall-clock parts of an instant in a time zone.
 *
 * Windows like `08:00`–`10:00` are meant as local time on the machine that runs the
 * crawl, so they are interpreted in the schedule's zone (default UTC). Using `Intl`
 * rather than fixed offsets means daylight saving is handled by the platform's own
 * database instead of by arithmetic here.
 */
export function zonedParts(date: Date, timeZone = 'UTC'): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    // `24` appears at midnight in some ICU versions; normalise it to 0.
    hour: Number(parts['hour']) % 24,
    minute: Number(parts['minute']),
    weekday: WEEKDAYS[parts['weekday'] ?? 'Mon'] ?? 1,
  };
}

/** Minutes since local midnight. */
export function minutesOfDay(date: Date, timeZone = 'UTC'): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

export interface ResolvedWindow {
  readonly fromMinutes: number;
  readonly toMinutes: number;
  /** True when the window runs past midnight, e.g. 22:00 -> 02:00. */
  readonly wraps: boolean;
  readonly lengthMinutes: number;
}

/** Resolves a schedule window, defaulting to the whole day when absent. */
export function resolveWindow(schedule: JobSchedule): ResolvedWindow {
  if (schedule.window === undefined) {
    return {
      fromMinutes: 0,
      toMinutes: MINUTES_PER_DAY,
      wraps: false,
      lengthMinutes: MINUTES_PER_DAY,
    };
  }
  const fromMinutes = parseClockTime(schedule.window.from);
  const toMinutes = parseClockTime(schedule.window.to);
  const wraps = toMinutes <= fromMinutes;
  const lengthMinutes = wraps ? MINUTES_PER_DAY - fromMinutes + toMinutes : toMinutes - fromMinutes;
  return { fromMinutes, toMinutes, wraps, lengthMinutes };
}

/** True when a local wall-clock minute falls inside the window. */
export function windowContains(window: ResolvedWindow, minute: number): boolean {
  if (!window.wraps) return minute >= window.fromMinutes && minute < window.toMinutes;
  return minute >= window.fromMinutes || minute < window.toMinutes;
}

function isoWeek(parts: ZonedParts): { year: number; week: number } {
  // ISO-8601: week 1 is the one containing the first Thursday of the year.
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = parts.weekday;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

/**
 * Identifier of the period an instant belongs to.
 *
 * For a window that wraps past midnight, the small hours belong to the period that
 * opened the evening before — otherwise a run at 00:30 and one at 23:30 the same
 * night would count as two separate days.
 */
export function periodKey(schedule: JobSchedule, date: Date, timeZone = 'UTC'): string {
  const window = resolveWindow(schedule);
  let anchor = date;

  if (window.wraps && minutesOfDay(date, timeZone) < window.toMinutes) {
    anchor = new Date(date.getTime() - MINUTES_PER_DAY * 60_000);
  }
  const parts = zonedParts(anchor, timeZone);

  switch (schedule.frequency) {
    case 'hourly':
      return `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}T${String(parts.hour)}`;
    case 'daily':
      return `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`;
    case 'weekly': {
      const { year, week } = isoWeek(parts);
      return `${String(year)}-W${String(week)}`;
    }
    case 'manual':
      return 'manual';
  }
}

/** Stable pseudo-random value in [0, 1) derived from a string. */
function unitHash(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  // 32 bits is ample resolution for a minute offset, and avoids BigInt.
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Minute within the hour (0..59) at which an hourly job fires.
 *
 * An hourly job jitters inside each hour; spreading it across a multi-hour window
 * would make it miss most of its hours.
 */
export function plannedMinuteOfHour(jobId: string, key: string): number {
  return Math.floor(unitHash(`${jobId}:${key}`) * 60);
}

/**
 * Minute of day at which a daily or weekly job fires, inside its window.
 *
 * Stable within a period, so asking twice does not move the answer earlier and the
 * job cannot creep forward every time the scheduler wakes.
 */
export function plannedMinuteOfDay(schedule: JobSchedule, jobId: string, key: string): number {
  const window = resolveWindow(schedule);
  if (window.lengthMinutes <= 1) return window.fromMinutes;

  const offset = Math.floor(unitHash(`${jobId}:${key}`) * window.lengthMinutes);
  return (window.fromMinutes + offset) % MINUTES_PER_DAY;
}

export interface DueOptions {
  readonly schedule: JobSchedule;
  readonly jobId: string;
  readonly now: Date;
  /** When the job last started a run, or `null` if it never has. */
  readonly lastRunAt: Date | null;
  readonly timeZone?: string;
}

export type NotDueReason =
  'manual' | 'outside-window' | 'before-planned-time' | 'already-ran-this-period';

export type DueVerdict =
  | { readonly due: true; readonly periodKey: string; readonly plannedMinute: number }
  | { readonly due: false; readonly reason: NotDueReason; readonly periodKey: string };

/** Decides whether a job should start a run now. Pure. */
export function isDue(options: DueOptions): DueVerdict {
  const { schedule, jobId, now, lastRunAt } = options;
  const timeZone = options.timeZone ?? 'UTC';
  const key = periodKey(schedule, now, timeZone);

  if (schedule.frequency === 'manual') {
    return { due: false, reason: 'manual', periodKey: key };
  }

  const window = resolveWindow(schedule);
  const nowMinute = minutesOfDay(now, timeZone);

  // The window bounds every frequency, hourly included: "every hour between 08:00
  // and 10:00" must not fire at 3am.
  if (!windowContains(window, nowMinute)) {
    return { due: false, reason: 'outside-window', periodKey: key };
  }

  // Already ran in this period: the schedule fires once per period, so a restarted
  // scheduler or an extra manual run cannot cause a second fire.
  if (lastRunAt !== null && periodKey(schedule, lastRunAt, timeZone) === key) {
    return { due: false, reason: 'already-ran-this-period', periodKey: key };
  }

  const planned =
    schedule.frequency === 'hourly'
      ? plannedMinuteOfHour(jobId, key)
      : plannedMinuteOfDay(schedule, jobId, key);

  const reached =
    schedule.frequency === 'hourly'
      ? nowMinute % 60 >= planned
      : window.wraps
        ? windowContains({ ...window, fromMinutes: planned }, nowMinute)
        : nowMinute >= planned;

  if (!reached) {
    return { due: false, reason: 'before-planned-time', periodKey: key };
  }
  return { due: true, periodKey: key, plannedMinute: planned };
}

/**
 * How many frontier entries this run should claim.
 *
 * `pagesPerRun` lets a job walk a large catalogue a slice at a time (spec §8). The
 * count is jittered between min and max for the same load-spreading reason as the
 * start time, and is stable within a period.
 */
export function pagesForRun(schedule: JobSchedule, jobId: string, key: string): number | null {
  const range = schedule.pagesPerRun;
  if (range === undefined) return null;
  if (range.max <= range.min) return range.max;

  const span = range.max - range.min + 1;
  return range.min + Math.floor(unitHash(`${jobId}:${key}:pages`) * span);
}
