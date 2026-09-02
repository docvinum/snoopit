/**
 * Resumption after a crash, exercised at the state level.
 *
 * A killed process leaves two scars: a run row stuck at `running`, and frontier
 * entries stuck at `leased`. These tests create exactly those scars and check that
 * the next run heals them — precisely, and without a subprocess, so they run
 * everywhere including a CI machine with no browser.
 *
 * The full kill-and-resume path, through the real CLI and a real SIGKILL, is in
 * `tests/e2e/kill-resume.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { RunOverlapError, runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job } from '../../src/state/types.js';
import { isoFromNow } from '../../src/util/time.js';

let store: Store;
let dataDir: string;
let job: Job;

const backend = (): FakeBackend => new FakeBackend({ routes: {} });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-resume-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'resume-job', workflow: 'noop' });
});

/** A workflow that does nothing, so tests observe the runner alone. */
const noop = workflow({ name: 'noop', run: () => Promise.resolve({ ok: true }) });

/**
 * Simulates a process killed mid-run: the row stays `running`, the heartbeat stops.
 *
 * `leaseExpiresIn` is what the killed run had left on its lease. A real crash leaves
 * a lease that has *not* expired — the run died seconds into a fifteen-minute lease —
 * so that is the case worth defending.
 */
function simulateCrash(
  entries: readonly string[],
  heartbeatAgeMs: number,
  leaseExpiresIn = -1000,
): string {
  const crashed = store.runs.start({ jobId: job.id, trigger: 'manual' });
  for (const url of entries) {
    store.frontier.enqueue({ jobId: job.id, url, canonicalUrl: url });
  }
  store.frontier.lease({
    jobId: job.id,
    runId: crashed.id,
    limit: entries.length,
    leaseExpiresAt: isoFromNow(leaseExpiresIn),
  });
  store.runs.heartbeat(crashed.id, isoFromNow(-heartbeatAgeMs));
  return crashed.id;
}

describe('crash recovery', () => {
  it('returns a dead run’s leased work to the queue', () => {
    simulateCrash(['u/1', 'u/2', 'u/3'], 10 * 60_000);
    expect(store.frontier.countByState(job.id)).toEqual({ leased: 3 });

    expect(store.frontier.reclaimAbandonedLeases(job.id)).toBe(3);
    expect(store.frontier.countByState(job.id)).toEqual({ queued: 3 });
  });

  it('reclaims a dead run’s lease even when it has not expired', () => {
    // The regression that matters: a run killed seconds into a fifteen-minute lease.
    // Waiting for the timer would strand its work for a quarter of an hour.
    const crashed = simulateCrash(['u/1', 'u/2'], 10 * 60_000, 15 * 60_000);
    store.runs.markAbandoned(crashed);

    expect(store.frontier.reclaimAbandonedLeases(job.id)).toBe(2);
    expect(store.frontier.countByState(job.id)).toEqual({ queued: 2 });
  });

  it('never disturbs a live run’s lease', () => {
    const live = store.runs.start({ jobId: job.id, trigger: 'manual' });
    store.frontier.enqueue({ jobId: job.id, url: 'u/1', canonicalUrl: 'u/1' });
    store.frontier.lease({
      jobId: job.id,
      runId: live.id,
      limit: 1,
      leaseExpiresAt: isoFromNow(15 * 60_000),
    });

    // The lease expiry is the signal, so work in progress is left alone.
    expect(store.frontier.reclaimAbandonedLeases(job.id)).toBe(0);
    expect(store.frontier.countByState(job.id)).toEqual({ leased: 1 });
  });

  it('closes an abandoned run as aborted rather than deleting it', async () => {
    const crashedId = simulateCrash(['u/1'], 10 * 60_000);

    const outcome = await runWorkflow(noop, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });

    const crashed = store.runs.get(crashedId)!;
    // The run happened and did work; erasing it would make the record lie.
    expect(crashed.status).toBe('aborted');
    expect(crashed.stopReason).toBe('abandoned');
    expect(crashed.finishedAt).not.toBeNull();

    expect(outcome.reclaimed).toBe(1);
    expect(store.runs.listByJob(job.id)).toHaveLength(2);
  });

  it('makes the reclaimed work available to the new run', async () => {
    simulateCrash(['u/1', 'u/2'], 10 * 60_000);

    const taking = workflow({
      name: 'taking',
      run: (ctx) => Promise.resolve({ took: ctx.frontier.take(10).map((e) => e.canonicalUrl) }),
    });

    const outcome = await runWorkflow(taking, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    expect(outcome.result).toEqual({ took: ['u/1', 'u/2'] });
  });

  it('reports the reclamation in the run’s events', async () => {
    simulateCrash(['u/1', 'u/2'], 10 * 60_000);
    const outcome = await runWorkflow(noop, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });

    const warned = store.events
      .listByRun(outcome.run.id)
      .find((event) => event.level === 'warn' && event.message?.includes('récupérée'));
    expect(warned).toBeDefined();
    expect(warned?.data).toMatchObject({ reclaimed: 2 });
  });
});

describe('overlap lock', () => {
  it('refuses to start while another run is genuinely alive', async () => {
    const live = store.runs.start({ jobId: job.id, trigger: 'manual' });
    store.runs.heartbeat(live.id);

    await expect(
      runWorkflow(noop, { store, job, browser: backend(), dataDir, onLine: () => undefined }),
    ).rejects.toThrow(RunOverlapError);
  });

  it('is not blocked forever by a dead run', async () => {
    // A lock file cannot tell these apart; a heartbeat can.
    const dead = store.runs.start({ jobId: job.id, trigger: 'manual' });
    store.runs.heartbeat(dead.id, isoFromNow(-10 * 60_000));

    const outcome = await runWorkflow(noop, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    expect(outcome.run.status).toBe('completed');
    expect(store.runs.get(dead.id)!.status).toBe('aborted');
  });

  it('does not lock a different job', async () => {
    const other = store.jobs.upsert({ name: 'other-job', workflow: 'noop' });
    const live = store.runs.start({ jobId: other.id, trigger: 'manual' });
    store.runs.heartbeat(live.id);

    const outcome = await runWorkflow(noop, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    expect(outcome.run.status).toBe('completed');
  });
});

describe('a run releases what it did not finish', () => {
  it('returns leased-but-unworked entries to the queue immediately', async () => {
    for (const url of ['u/1', 'u/2', 'u/3']) {
      store.frontier.enqueue({ jobId: job.id, url, canonicalUrl: url });
    }

    const partial = workflow({
      name: 'partial',
      run: (ctx) => {
        const taken = ctx.frontier.take(3);
        ctx.frontier.complete(taken[0]!); // only one of three is finished
        return Promise.resolve({ done: 1 });
      },
    });

    await runWorkflow(partial, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });

    // Unfinished work goes back at once, rather than waiting out a lease nobody holds.
    expect(store.frontier.countByState(job.id)).toEqual({ done: 1, queued: 2 });
  });
});
