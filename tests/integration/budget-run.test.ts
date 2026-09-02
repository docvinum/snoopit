/**
 * Budgets, as they behave inside a real run.
 *
 * The central property: exhausting a budget ends the run `completed`, with a
 * `stopReason` naming the limit. A truncated run must not look like a failure, and
 * must not look like a site that lost half its pages either — hence the limits
 * appearing in the report.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job, RunBudget } from '../../src/state/types.js';
import { canonicalizeUrlOrThrow } from '../../src/runtime/navigation/canonical.js';
import { buildFakeSite } from '../support/fake-site.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

let server: FixtureServer;
let store: Store;
let dataDir: string;
let job: Job;

beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-budget-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'budget-job', workflow: 'walker' });
});

const backend = (): FakeBackend => new FakeBackend(buildFakeSite(server.origin));

/** Visits the index repeatedly, until something stops it. */
function walker(times: number) {
  return workflow({
    name: 'walker',
    async run(ctx) {
      let visited = 0;
      for (let i = 0; i < times; i += 1) {
        const { page } = await ctx.visit(server.url('/index.html'));
        await page.close();
        visited += 1;
      }
      return { visited };
    },
  });
}

async function run(definition: ReturnType<typeof walker>, budget: RunBudget) {
  return runWorkflow(definition, {
    store,
    job,
    browser: backend(),
    dataDir,
    budget,
    onLine: () => undefined,
  });
}

describe('budget enforcement', () => {
  it('stops cleanly at maxPages, as a completed run', async () => {
    const outcome = await run(walker(20), { maxPages: 3 });

    // Exhausting a budget is not a failure: the run did what it was allowed to do.
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('budget:max_pages');
    expect(outcome.budgetLimit).toBe('max_pages');
    expect(outcome.error).toBeNull();
    expect(outcome.run.counters.pagesVisited).toBe(3);
  });

  it('emits BUDGET_REACHED with the numbers', async () => {
    const outcome = await run(walker(20), { maxPages: 2 });
    const event = store.events
      .listByRun(outcome.run.id)
      .find((candidate) => candidate.type === 'BUDGET_REACHED');

    expect(event).toBeDefined();
    expect(event?.level).toBe('warn');
    expect(event?.data).toMatchObject({ limit: 'max_pages', used: 2, max: 2 });
  });

  it('records the limits in force in both reports', async () => {
    const outcome = await run(walker(20), { maxPages: 2, maxDuration: '5m' });

    const markdown = readFileSync(resolve(dataDir, outcome.reportPath), 'utf8');
    const json = JSON.parse(readFileSync(resolve(dataDir, outcome.reportJsonPath), 'utf8')) as {
      budget: Record<string, unknown>;
      run: { stopReason: string };
    };

    // A truncated run has to explain itself, or it looks like a shrinking site.
    expect(markdown).toContain('## Budget');
    expect(markdown).toContain('`maxPages` | 2');
    expect(json.budget).toMatchObject({ maxPages: 2, maxDuration: '5m' });
    expect(json.run.stopReason).toBe('budget:max_pages');
  });

  it('runs to completion when the budget is generous', async () => {
    const outcome = await run(walker(3), { maxPages: 50 });
    expect(outcome.run.stopReason).toBe('done');
    expect(outcome.budgetLimit).toBeNull();
    expect(outcome.result).toEqual({ visited: 3 });
  });

  it('stops on the error budget', async () => {
    const failing = workflow({
      name: 'failing',
      async run(ctx) {
        for (let i = 0; i < 10; i += 1) {
          const { page } = await ctx.visit(server.url(`/missing-${String(i)}.html`));
          await page.close();
        }
        return { done: true };
      },
    });

    const outcome = await runWorkflow(failing, {
      store,
      job,
      browser: backend(),
      dataDir,
      budget: { maxErrors: 2 },
      onLine: () => undefined,
    });

    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('budget:max_errors');
    expect(outcome.run.counters.errorCount).toBe(2);
  });

  it('does not let a zero LLM budget block a nominal run', async () => {
    // Declaring `maxLlmCalls: 0` states that the workflow uses no LLM. It must not
    // prevent the workflow from doing its ordinary, LLM-free work.
    const outcome = await run(walker(3), { maxPages: 10, maxLlmCalls: 0 });
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('done');
    expect(outcome.run.counters.pagesVisited).toBe(3);
    expect(outcome.run.counters.llmCalls).toBe(0);
  });

  it('bounds a frontier batch by what is left of the budget', async () => {
    const taking = workflow({
      name: 'taking',
      run(ctx) {
        for (let i = 0; i < 20; i += 1) {
          ctx.frontier.discover(`https://e.com/${String(i)}`);
        }
        // Never claim work the run could not finish: an abandoned lease costs time.
        return Promise.resolve({ took: ctx.frontier.take(20).length });
      },
    });

    const outcome = await runWorkflow(taking, {
      store,
      job,
      browser: backend(),
      dataDir,
      budget: { maxPages: 4 },
      onLine: () => undefined,
    });
    expect(outcome.result).toEqual({ took: 4 });
  });

  it('bounds a frontier batch by pagesPerRun across the whole run', async () => {
    const taking = workflow({
      name: 'taking',
      run(ctx) {
        for (let i = 0; i < 20; i += 1) {
          ctx.frontier.discover(`https://e.com/${String(i)}`);
        }
        const first = ctx.frontier.take(10).length;
        const second = ctx.frontier.take(10).length;
        return Promise.resolve({ first, second });
      },
    });

    const outcome = await runWorkflow(taking, {
      store,
      job,
      browser: backend(),
      dataDir,
      pagesPerRun: 7,
      onLine: () => undefined,
    });
    // The cap spans the run, not each call.
    expect(outcome.result).toEqual({ first: 7, second: 0 });
  });
});

describe('revisits', () => {
  it('re-queues a page whose revisit time has come, and not before', async () => {
    const url = server.url('/index.html');

    const marking = workflow({
      name: 'marking',
      async run(ctx) {
        // Re-queue due revisits at the start of the run, before visiting anything:
        // a visit refreshes `next_visit_after`, so checking afterwards would always
        // find nothing due.
        const queuedNow = ctx.frontier.enqueueDueRevisits();
        const { page } = await ctx.visit(url, { revisitAfter: '1h' });
        await page.close();
        return { queuedNow };
      },
    });

    const first = await runWorkflow(marking, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    // Not due for an hour, so nothing is queued yet.
    expect(first.result).toEqual({ queuedNow: 0 });

    // Pages are keyed by canonical URL, so that is the lookup key.
    const page = store.pages.get(job.id, canonicalizeUrlOrThrow(url))!;
    expect(page.nextVisitAfter).not.toBeNull();

    // Move the due date into the past, as an hour passing would.
    store.db
      .prepare('UPDATE crawl_pages SET next_visit_after = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', page.id);

    const second = await runWorkflow(marking, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    expect(second.result).toEqual({ queuedNow: 1 });
  });
});
