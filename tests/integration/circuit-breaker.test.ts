import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeResponse } from '../../src/runtime/browser/fake.js';
import { canonicalizeUrlOrThrow } from '../../src/runtime/navigation/canonical.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';

const SITE = 'http://www.site.test';
const BREAKER = { disableOn: ['error', 'blocked', 'auth-required'] as const };

function html(body: string): FakeResponse {
  return { status: 200, body: `<html><body>${body}</body></html>` };
}

async function run(definition: ReturnType<typeof workflow>, routes: Record<string, FakeResponse>) {
  const store = Store.memory();
  const job = store.jobs.upsert({ name: definition.name, workflow: definition.name });
  const outcome = await runWorkflow(definition, {
    store,
    job,
    browser: new FakeBackend({ routes }),
    dataDir: mkdtempSync(join(tmpdir(), 'snoopit-breaker-')),
    onLine: () => undefined,
  });
  return { store, job, outcome };
}

describe('workflow circuit breaker', () => {
  it('disables its job and records why after an unexpected error', async () => {
    const definition = workflow({
      name: 'unexpected-error',
      circuitBreaker: BREAKER,
      run: () => Promise.reject(new Error('unexpected')),
    });
    const { store, job, outcome } = await run(definition, {});

    expect(outcome.run.stopReason).toBe('error');
    expect(store.jobs.get(job.id)?.enabled).toBe(false);
    expect(store.events.listByRun(outcome.run.id)).toContainEqual(
      expect.objectContaining({ type: 'JOB_DISABLED', data: { reason: 'error' } }),
    );
  });

  it('opens the circuit on a site block or expired session', async () => {
    const blocked = workflow({
      name: 'blocked',
      circuitBreaker: BREAKER,
      run: async (ctx) => {
        await ctx.visit(`${SITE}/blocked`);
      },
    });
    const blockedResult = await run(blocked, {
      [canonicalizeUrlOrThrow(`${SITE}/blocked`)]: { status: 403, body: 'Access denied' },
    });
    expect(blockedResult.store.jobs.get(blockedResult.job.id)?.enabled).toBe(false);
    expect(blockedResult.outcome.run.stopReason).toBe('blocked:http-forbidden');

    const auth = workflow({
      name: 'expired-session',
      circuitBreaker: BREAKER,
      run: async (ctx) => {
        await ctx.visit(`${SITE}/private`, { session: { expectHost: 'www.site.test' } });
      },
    });
    const login = 'http://auth.site.test/login';
    const authResult = await run(auth, {
      [canonicalizeUrlOrThrow(`${SITE}/private`)]: { redirectTo: login },
      [canonicalizeUrlOrThrow(login)]: html('Sign in'),
    });
    expect(authResult.store.jobs.get(authResult.job.id)?.enabled).toBe(false);
    expect(authResult.outcome.run.stopReason).toBe('auth-required');
  });
});
