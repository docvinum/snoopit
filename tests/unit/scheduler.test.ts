import { describe, expect, it } from 'vitest';
import {
  isDue,
  minutesOfDay,
  pagesForRun,
  periodKey,
  plannedMinuteOfDay,
  plannedMinuteOfHour,
  resolveWindow,
  windowContains,
  zonedParts,
} from '../../src/scheduler/window.js';
import type { JobSchedule } from '../../src/state/types.js';

const DAILY_MORNING: JobSchedule = {
  frequency: 'daily',
  window: { from: '08:00', to: '10:00' },
};

const utc = (iso: string): Date => new Date(iso);

describe('zonedParts', () => {
  it('reads wall-clock parts in UTC', () => {
    expect(zonedParts(utc('2026-08-31T08:30:00Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 31,
      hour: 8,
      minute: 30,
      weekday: 1,
    });
  });

  it('reads them in a named zone, applying the offset in force', () => {
    // Paris is UTC+2 in August (summer time) and UTC+1 in January.
    expect(minutesOfDay(utc('2026-08-31T08:30:00Z'), 'Europe/Paris')).toBe(10 * 60 + 30);
    expect(minutesOfDay(utc('2026-01-31T08:30:00Z'), 'Europe/Paris')).toBe(9 * 60 + 30);
  });

  it('normalises midnight to hour 0', () => {
    expect(zonedParts(utc('2026-08-31T00:00:00Z')).hour).toBe(0);
  });
});

describe('resolveWindow', () => {
  it('defaults to the whole day', () => {
    expect(resolveWindow({ frequency: 'daily' })).toEqual({
      fromMinutes: 0,
      toMinutes: 1440,
      wraps: false,
      lengthMinutes: 1440,
    });
  });

  it('resolves an ordinary window', () => {
    expect(resolveWindow(DAILY_MORNING)).toMatchObject({
      fromMinutes: 480,
      toMinutes: 600,
      wraps: false,
      lengthMinutes: 120,
    });
  });

  it('detects a window that runs past midnight', () => {
    const night = resolveWindow({ frequency: 'daily', window: { from: '22:00', to: '02:00' } });
    expect(night.wraps).toBe(true);
    expect(night.lengthMinutes).toBe(240);
  });
});

describe('windowContains', () => {
  it('is inclusive of the start and exclusive of the end', () => {
    const window = resolveWindow(DAILY_MORNING);
    expect(windowContains(window, 480)).toBe(true);
    expect(windowContains(window, 599)).toBe(true);
    expect(windowContains(window, 600)).toBe(false);
    expect(windowContains(window, 479)).toBe(false);
  });

  it('handles a wrapping window on both sides of midnight', () => {
    const night = resolveWindow({ frequency: 'daily', window: { from: '22:00', to: '02:00' } });
    expect(windowContains(night, 23 * 60)).toBe(true);
    expect(windowContains(night, 30)).toBe(true);
    expect(windowContains(night, 12 * 60)).toBe(false);
  });
});

describe('periodKey', () => {
  it('is one key per calendar day for a daily schedule', () => {
    const a = periodKey(DAILY_MORNING, utc('2026-08-31T08:10:00Z'));
    const b = periodKey(DAILY_MORNING, utc('2026-08-31T09:50:00Z'));
    const c = periodKey(DAILY_MORNING, utc('2026-09-01T08:10:00Z'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is one key per clock hour for an hourly schedule', () => {
    const schedule: JobSchedule = { frequency: 'hourly' };
    expect(periodKey(schedule, utc('2026-08-31T08:05:00Z'))).toBe(
      periodKey(schedule, utc('2026-08-31T08:55:00Z')),
    );
    expect(periodKey(schedule, utc('2026-08-31T08:05:00Z'))).not.toBe(
      periodKey(schedule, utc('2026-08-31T09:05:00Z')),
    );
  });

  it('is one key per ISO week for a weekly schedule', () => {
    const schedule: JobSchedule = { frequency: 'weekly' };
    // Monday and Sunday of the same ISO week.
    expect(periodKey(schedule, utc('2026-08-31T08:00:00Z'))).toBe(
      periodKey(schedule, utc('2026-09-06T08:00:00Z')),
    );
    expect(periodKey(schedule, utc('2026-08-31T08:00:00Z'))).not.toBe(
      periodKey(schedule, utc('2026-09-07T08:00:00Z')),
    );
  });

  it('anchors a wrapping window on the evening it opened', () => {
    // 23:30 and 00:30 the same night are one period, not two days.
    const night: JobSchedule = { frequency: 'daily', window: { from: '22:00', to: '02:00' } };
    expect(periodKey(night, utc('2026-08-31T23:30:00Z'))).toBe(
      periodKey(night, utc('2026-09-01T00:30:00Z')),
    );
  });

  it('follows the schedule time zone, not UTC', () => {
    // 23:30 UTC is already the next day in Paris.
    expect(periodKey(DAILY_MORNING, utc('2026-08-31T23:30:00Z'), 'Europe/Paris')).not.toBe(
      periodKey(DAILY_MORNING, utc('2026-08-31T23:30:00Z'), 'UTC'),
    );
  });
});

describe('jitter', () => {
  it('is stable for a job within a period, so a job does not creep earlier', () => {
    const key = periodKey(DAILY_MORNING, utc('2026-08-31T08:00:00Z'));
    const first = plannedMinuteOfDay(DAILY_MORNING, 'job-a', key);
    const second = plannedMinuteOfDay(DAILY_MORNING, 'job-a', key);
    expect(first).toBe(second);
  });

  it('lands inside the window', () => {
    for (let day = 1; day <= 28; day += 1) {
      const date = utc(`2026-09-${String(day).padStart(2, '0')}T08:00:00Z`);
      const minute = plannedMinuteOfDay(DAILY_MORNING, 'job-a', periodKey(DAILY_MORNING, date));
      expect(minute).toBeGreaterThanOrEqual(480);
      expect(minute).toBeLessThan(600);
    }
  });

  it('spreads different jobs across the window rather than stacking them', () => {
    const key = periodKey(DAILY_MORNING, utc('2026-08-31T08:00:00Z'));
    const minutes = Array.from({ length: 40 }, (_, i) =>
      plannedMinuteOfDay(DAILY_MORNING, `job-${String(i)}`, key),
    );
    // Load spreading is the point; all-identical would defeat it.
    expect(new Set(minutes).size).toBeGreaterThan(20);
  });

  it('keeps an hourly job inside its hour', () => {
    for (let i = 0; i < 30; i += 1) {
      const minute = plannedMinuteOfHour(`job-${String(i)}`, '2026-8-31T8');
      expect(minute).toBeGreaterThanOrEqual(0);
      expect(minute).toBeLessThan(60);
    }
  });
});

describe('isDue', () => {
  const jobId = 'demo-job';

  it('never fires a manual schedule', () => {
    const verdict = isDue({
      schedule: { frequency: 'manual' },
      jobId,
      now: utc('2026-08-31T09:00:00Z'),
      lastRunAt: null,
    });
    expect(verdict).toMatchObject({ due: false, reason: 'manual' });
  });

  it('refuses outside the window', () => {
    expect(
      isDue({ schedule: DAILY_MORNING, jobId, now: utc('2026-08-31T03:00:00Z'), lastRunAt: null }),
    ).toMatchObject({ due: false, reason: 'outside-window' });
  });

  it('waits for the jittered moment inside the window', () => {
    const key = periodKey(DAILY_MORNING, utc('2026-08-31T08:00:00Z'));

    // Pick a job whose jittered minute is not the very first of the window, so
    // "before the planned time" is a real instant to test.
    const lateJob = Array.from({ length: 50 }, (_, i) => `job-${String(i)}`).find(
      (id) => plannedMinuteOfDay(DAILY_MORNING, id, key) > 481,
    )!;
    const planned = plannedMinuteOfDay(DAILY_MORNING, lateJob, key);

    const justBefore = new Date(Date.UTC(2026, 7, 31, 0, planned - 1));
    expect(
      isDue({ schedule: DAILY_MORNING, jobId: lateJob, now: justBefore, lastRunAt: null }),
    ).toMatchObject({ due: false, reason: 'before-planned-time' });

    const atPlanned = new Date(Date.UTC(2026, 7, 31, 0, planned));
    expect(
      isDue({ schedule: DAILY_MORNING, jobId: lateJob, now: atPlanned, lastRunAt: null }),
    ).toMatchObject({ due: true, plannedMinute: planned });
  });

  it('fires once per period, whatever else happened', () => {
    const key = periodKey(DAILY_MORNING, utc('2026-08-31T08:00:00Z'));
    const planned = plannedMinuteOfDay(DAILY_MORNING, jobId, key);
    const now = new Date(Date.UTC(2026, 7, 31, 0, planned + 5));

    // A restarted scheduler, or an extra manual run, must not cause a second fire.
    expect(
      isDue({
        schedule: DAILY_MORNING,
        jobId,
        now,
        lastRunAt: new Date(Date.UTC(2026, 7, 31, 8, 5)),
      }),
    ).toMatchObject({ due: false, reason: 'already-ran-this-period' });

    expect(
      isDue({
        schedule: DAILY_MORNING,
        jobId,
        now,
        lastRunAt: new Date(Date.UTC(2026, 7, 30, 8, 5)),
      }),
    ).toMatchObject({ due: true });
  });

  it('bounds an hourly schedule by its window too', () => {
    // "Every hour between 08:00 and 10:00" must not fire at 3am.
    const hourly: JobSchedule = { frequency: 'hourly', window: { from: '08:00', to: '10:00' } };
    expect(
      isDue({ schedule: hourly, jobId, now: utc('2026-08-31T03:30:00Z'), lastRunAt: null }),
    ).toMatchObject({ due: false, reason: 'outside-window' });
  });

  it('fires an hourly schedule once in each hour of its window', () => {
    const hourly: JobSchedule = { frequency: 'hourly' };
    const planned = plannedMinuteOfHour(jobId, periodKey(hourly, utc('2026-08-31T08:00:00Z')));
    const now = new Date(Date.UTC(2026, 7, 31, 8, planned));

    expect(isDue({ schedule: hourly, jobId, now, lastRunAt: null })).toMatchObject({ due: true });
    expect(
      isDue({ schedule: hourly, jobId, now, lastRunAt: new Date(Date.UTC(2026, 7, 31, 8, 1)) }),
    ).toMatchObject({ due: false, reason: 'already-ran-this-period' });
    // The next hour is a new period.
    expect(
      isDue({
        schedule: hourly,
        jobId,
        now: new Date(Date.UTC(2026, 7, 31, 9, 59)),
        lastRunAt: new Date(Date.UTC(2026, 7, 31, 8, 1)),
      }),
    ).toMatchObject({ due: true });
  });

  it('interprets the window in the schedule time zone', () => {
    // 08:30 UTC is 10:30 in Paris — past a 08:00-10:00 Paris window.
    const now = utc('2026-08-31T08:30:00Z');
    expect(
      isDue({ schedule: DAILY_MORNING, jobId, now, lastRunAt: null, timeZone: 'Europe/Paris' }),
    ).toMatchObject({ due: false, reason: 'outside-window' });
    expect(
      isDue({ schedule: DAILY_MORNING, jobId, now, lastRunAt: null, timeZone: 'UTC' }).periodKey,
    ).toBeDefined();
  });
});

describe('pagesForRun', () => {
  it('returns null when the job sets no range', () => {
    expect(pagesForRun({ frequency: 'daily' }, 'job', 'key')).toBeNull();
  });

  it('stays within min and max', () => {
    const schedule: JobSchedule = { frequency: 'daily', pagesPerRun: { min: 10, max: 100 } };
    for (let i = 0; i < 50; i += 1) {
      const pages = pagesForRun(schedule, `job-${String(i)}`, 'key')!;
      expect(pages).toBeGreaterThanOrEqual(10);
      expect(pages).toBeLessThanOrEqual(100);
    }
  });

  it('is stable within a period', () => {
    const schedule: JobSchedule = { frequency: 'daily', pagesPerRun: { min: 10, max: 100 } };
    expect(pagesForRun(schedule, 'job', 'key')).toBe(pagesForRun(schedule, 'job', 'key'));
  });

  it('handles a degenerate range', () => {
    expect(pagesForRun({ frequency: 'daily', pagesPerRun: { min: 5, max: 5 } }, 'j', 'k')).toBe(5);
  });
});
