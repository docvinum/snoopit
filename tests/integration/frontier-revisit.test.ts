/**
 * Work reached without `visit` — by a click, typically — must still come back.
 *
 * `visit(url, { revisitAfter })` schedules the pages it loads; `frontier.complete`
 * and `frontier.fail` take the same option for everything else. Without it, an
 * entry worked once is done forever, and a daily job silently stops at day one.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow, type RevisitOption } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job } from '../../src/state/types.js';

let store: Store;
let dataDir: string;
let job: Job;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-revisit-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'revisit', workflow: 'worker' });
});

/** Requeues what is due, then works (completes or fails) every queued entry. */
function worker(outcome: 'complete' | 'fail', options: RevisitOption = {}) {
  return workflow({
    name: 'worker',
    run(ctx) {
      ctx.frontier.enqueueDueRevisits();
      ctx.frontier.discover('https://site.test/recherche?id=1');
      const worked = ctx.frontier.take(10);
      for (const entry of worked) {
        if (outcome === 'complete') ctx.frontier.complete(entry, options);
        else ctx.frontier.fail(entry, 'unreadable', options);
      }
      return Promise.resolve({ worked: worked.length });
    },
  });
}

async function run(definition: ReturnType<typeof worker>) {
  const outcome = await runWorkflow(definition, {
    store,
    job,
    browser: new FakeBackend({ routes: {} }),
    dataDir,
    onLine: () => undefined,
  });
  return outcome.result as { worked: number };
}

describe('frontier revisits for work reached without visit()', () => {
  it('brings a completed entry back once its revisit time has passed', async () => {
    expect(await run(worker('complete', { revisitAfter: '0s' }))).toEqual({ worked: 1 });
    expect(await run(worker('complete', { revisitAfter: '0s' }))).toEqual({ worked: 1 });
  });

  it('leaves it done until then', async () => {
    await run(worker('complete', { revisitAfter: '20h' }));
    expect(await run(worker('complete', { revisitAfter: '20h' }))).toEqual({ worked: 0 });
  });

  it('keeps a completed entry done for good without the option', async () => {
    await run(worker('complete'));
    expect(await run(worker('complete'))).toEqual({ worked: 0 });
  });

  it('retries a failed entry after its delay', async () => {
    await run(worker('fail', { revisitAfter: '0s' }));
    expect(await run(worker('fail', { revisitAfter: '0s' }))).toEqual({ worked: 1 });
  });
});
