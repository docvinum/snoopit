/**
 * Recovery as it behaves inside a run: events, the LLM budget, and blocking.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { ScriptedLlmProvider } from '../../src/runtime/recovery/llm/scripted.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job } from '../../src/state/types.js';
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
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-recovery-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'recovery-job', workflow: 'gated' });
});

const backend = (): FakeBackend => new FakeBackend(buildFakeSite(server.origin));

/** Opens the gated page and asks recovery to reveal the publication list. */
const gated = workflow({
  name: 'gated',
  async run(ctx) {
    const { page } = await ctx.visit(server.url('/gated.html'));
    const outcome = await ctx.recover(page, {
      goal: 'Accéder à la liste des publications',
      expectedState: { selector: '.publication-list' },
    });
    const items = await ctx.extract(page, {
      selector: '.publication',
      fields: { title: '.title' },
    });
    await page.close();
    return { level: outcome.level, llmCalls: outcome.llmCalls, items: items.length };
  },
});

describe('recovery inside a run', () => {
  it('recovers at L1 and spends nothing from the LLM budget', async () => {
    const llm = new ScriptedLlmProvider([{ text: 'never called' }]);
    const outcome = await runWorkflow(gated, {
      store,
      job,
      browser: backend(),
      llm,
      dataDir,
      budget: { maxLlmCalls: 3 },
      onLine: () => undefined,
    });

    expect(outcome.run.status).toBe('completed');
    expect(outcome.result).toMatchObject({ level: 'L1', llmCalls: 0, items: 1 });
    // The counter that proves the design holds, run after run.
    expect(outcome.run.counters.llmCalls).toBe(0);
    expect(llm.callCount).toBe(0);
  });

  it('records what recovery did, so the run stays explainable', async () => {
    const outcome = await runWorkflow(gated, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });

    const events = store.events.listByRun(outcome.run.id);
    const started = events.find((event) => event.type === 'RECOVERY_STARTED');
    const succeeded = events.find((event) => event.type === 'RECOVERY_SUCCEEDED');

    expect(started?.message).toBe('Accéder à la liste des publications');
    expect(succeeded?.data).toMatchObject({ level: 'L1', llmCalls: 0 });
    // A dismissal that happens silently is indistinguishable from a site that
    // behaved differently today, so the steps are part of the record.
    expect(JSON.stringify(succeeded?.data)).toContain('close_overlay');
  });

  it('counts model calls against the run and its budget', async () => {
    const llm = new ScriptedLlmProvider([
      { text: '{"action":"give_up","reason":"a"}' },
      { text: '{"action":"give_up","reason":"b"}' },
    ]);

    const unreachable = workflow({
      name: 'unreachable',
      async run(ctx) {
        const { page } = await ctx.visit(server.url('/index.html'));
        try {
          await ctx.recover(page, {
            goal: 'Atteindre une chose absente',
            expectedState: { selector: '.absent' },
            maxSteps: 1,
          });
        } catch {
          // L4 is an expected outcome here.
        }
        await page.close();
        return { done: true };
      },
    });

    const outcome = await runWorkflow(unreachable, {
      store,
      job,
      browser: backend(),
      llm,
      dataDir,
      budget: { maxLlmCalls: 5 },
      onLine: () => undefined,
    });

    expect(llm.callCount).toBe(2);
    expect(outcome.run.counters.llmCalls).toBe(2);
  });

  it('stops the run cleanly when the LLM budget is spent', async () => {
    const llm = new ScriptedLlmProvider([
      { text: '{"action":"give_up","reason":"a"}' },
      { text: '{"action":"give_up","reason":"b"}' },
    ]);

    const unreachable = workflow({
      name: 'unreachable',
      async run(ctx) {
        const { page } = await ctx.visit(server.url('/index.html'));
        await ctx.recover(page, {
          goal: 'Atteindre une chose absente',
          expectedState: { selector: '.absent' },
          maxSteps: 4,
        });
        await page.close();
        return { done: true };
      },
    });

    const outcome = await runWorkflow(unreachable, {
      store,
      job,
      browser: backend(),
      llm,
      dataDir,
      budget: { maxLlmCalls: 1 },
      onLine: () => undefined,
    });

    // A recovery loop cannot quietly become the run's main cost.
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('budget:max_llm_calls');
    expect(outcome.run.counters.llmCalls).toBe(1);
  });

  it('reports being blocked as a deliberate stop, not a failure', async () => {
    const llm = new ScriptedLlmProvider([{ text: 'never called' }]);

    const challenged = workflow({
      name: 'challenged',
      async run(ctx) {
        const { page } = await ctx.visit(server.url('/challenged.html'));
        await ctx.recover(page, {
          goal: 'Accéder aux publications',
          expectedState: { selector: '.publication-list' },
        });
        await page.close();
        return { done: true };
      },
    });

    const outcome = await runWorkflow(challenged, {
      store,
      job,
      browser: backend(),
      llm,
      dataDir,
      onLine: () => undefined,
    });

    expect(outcome.blocked).not.toBeNull();
    expect(outcome.blocked?.signal.reason).toBe('captcha');
    expect(outcome.run.stopReason).toBe('blocked:captcha');
    // Not `failed`: the site answered, and we respected the answer.
    expect(outcome.run.status).toBe('completed');
    expect(outcome.error).toBeNull();
    expect(llm.callCount).toBe(0);

    const blockedEvent = store.events
      .listByRun(outcome.run.id)
      .find((event) => event.type === 'BLOCKED');
    expect(blockedEvent?.level).toBe('error');
    expect(blockedEvent?.data).toMatchObject({ reason: 'captcha' });
  });

  it('dismisses overlays on request, without any recovery ceremony', async () => {
    const simple = workflow({
      name: 'simple',
      async run(ctx) {
        const { page } = await ctx.visit(server.url('/gated.html'));
        const result = await ctx.dismissOverlays(page);
        const list = await page.query('.publication-list');
        await page.close();
        return { dismissed: result.dismissed.length, listVisible: list?.view.display !== 'none' };
      },
    });

    const outcome = await runWorkflow(simple, {
      store,
      job,
      browser: backend(),
      dataDir,
      onLine: () => undefined,
    });
    expect(outcome.result).toEqual({ dismissed: 1, listVisible: true });
  });
});
