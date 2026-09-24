/**
 * The scheduler pass as the CLI runs it: which zone a window is read in, and that
 * one broken job never takes the rest of the tick down with it.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { workflow, type WorkflowDefinition } from '../../src/runtime/workflow/types.js';
import { dueJobs, evaluateJobs } from '../../src/scheduler/scheduler.js';
import { runDueJobs } from '../../src/scheduler/tick.js';
import { Store } from '../../src/state/store.js';

let store: Store;

beforeEach(() => {
  store = Store.memory();
});

// 07:00 UTC on a summer day is 09:00 in Paris (CEST, UTC+2).
const NOW = new Date('2026-07-01T07:00:30Z');
// A one-minute window fires at its first minute: no jitter to reason about.
const PARIS_NINE = { frequency: 'daily' as const, window: { from: '09:00', to: '09:01' } };

describe('schedule time zones', () => {
  it('reads a window in the zone the job names', () => {
    store.jobs.upsert({
      name: 'paris',
      workflow: 'w',
      schedule: { ...PARIS_NINE, timeZone: 'Europe/Paris' },
    });
    const [decision] = evaluateJobs(store, { now: NOW });
    expect(decision?.verdict.due).toBe(true);
  });

  it('falls back to the scheduler default for a job without a zone', () => {
    store.jobs.upsert({ name: 'paris', workflow: 'w', schedule: PARIS_NINE });

    expect(dueJobs(store, { now: NOW, timeZone: 'Europe/Paris' })).toHaveLength(1);
    // Read in UTC, the same window is two hours away.
    const [decision] = evaluateJobs(store, { now: NOW });
    expect(decision?.verdict).toMatchObject({ due: false, reason: 'outside-window' });
  });

  it("lets the job's own zone win over the default", () => {
    store.jobs.upsert({
      name: 'paris',
      workflow: 'w',
      schedule: { ...PARIS_NINE, timeZone: 'Europe/Paris' },
    });
    expect(dueJobs(store, { now: NOW, timeZone: 'America/New_York' })).toHaveLength(1);
  });
});

describe('runDueJobs', () => {
  const ok = workflow({ name: 'ok', run: () => Promise.resolve({ fine: true }) });

  function decisionsFor(...names: string[]) {
    return names.map((name) => ({
      job: store.jobs.upsert({ name, workflow: name }),
      verdict: { due: true as const, periodKey: 'k', plannedMinute: 0 },
      pagesPerRun: null,
    }));
  }

  it('keeps going when a job names a workflow that no longer exists', async () => {
    const errors: string[] = [];
    const result = await runDueJobs(decisionsFor('missing', 'ok'), {
      store,
      loadWorkflow: (name) =>
        name === 'ok'
          ? Promise.resolve(ok as WorkflowDefinition)
          : Promise.reject(new Error(`Unknown workflow "${name}"`)),
      connect: () => Promise.resolve(new FakeBackend({ routes: {} })),
      runOptions: { dataDir: mkdtempSync(join(tmpdir(), 'snoopit-tick-')), onLine: () => {} },
      log: () => {},
      logError: (line) => errors.push(line),
    });

    expect(result).toEqual({ ran: 2, failures: 1 });
    expect(errors).toEqual(['missing: Unknown workflow "missing"']);
    expect(store.runs.latestForJob('ok')?.status).toBe('completed');
  });

  it('applies the configured default budget to scheduled runs', async () => {
    const endless = workflow({
      name: 'endless',
      async run(ctx) {
        for (;;) {
          const { page } = await ctx.visit('http://site.test/');
          await page.close();
        }
      },
    });

    await runDueJobs(decisionsFor('endless'), {
      store,
      loadWorkflow: () => Promise.resolve(endless as WorkflowDefinition),
      connect: () =>
        Promise.resolve(
          new FakeBackend({ routes: { 'http://site.test/': { status: 200, body: 'ok' } } }),
        ),
      runOptions: {
        dataDir: mkdtempSync(join(tmpdir(), 'snoopit-tick-')),
        defaultBudget: { maxPages: 3 },
        onLine: () => {},
      },
      log: () => {},
      logError: () => {},
    });

    expect(store.runs.latestForJob('endless')?.stopReason).toBe('budget:max_pages');
  });

  it('keeps going when the browser cannot be reached for one job', async () => {
    let attempts = 0;
    const result = await runDueJobs(decisionsFor('first', 'second'), {
      store,
      loadWorkflow: () => Promise.resolve(ok as WorkflowDefinition),
      connect: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9222'))
          : Promise.resolve(new FakeBackend({ routes: {} }));
      },
      runOptions: { dataDir: mkdtempSync(join(tmpdir(), 'snoopit-tick-')), onLine: () => {} },
      log: () => {},
      logError: () => {},
    });

    expect(result.failures).toBe(1);
    expect(store.runs.latestForJob('second')?.status).toBe('completed');
  });
});
