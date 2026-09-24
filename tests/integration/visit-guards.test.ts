/**
 * What `ctx.visit` refuses to record as a visit, and what it stops the run for.
 *
 * Three situations look like a successful navigation to a naive crawler and are
 * not: a site refusing us, a login wall where a members-only page should be, and a
 * redirect to another site. In each, recording the page as visited would store the
 * wrong content under the URL and report a change that never happened.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeResponse } from '../../src/runtime/browser/fake.js';
import type { PageHandle } from '../../src/runtime/browser/types.js';
import { canonicalizeUrlOrThrow } from '../../src/runtime/navigation/canonical.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow, type VisitOptions, type VisitResult } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job } from '../../src/state/types.js';

const SITE = 'http://www.site.test';

let store: Store;
let dataDir: string;
let job: Job;
let routes: Record<string, FakeResponse>;

function serve(url: string, response: FakeResponse): void {
  routes[canonicalizeUrlOrThrow(url)] = response;
}

const html = (body: string, status = 200): FakeResponse => ({
  status,
  body: `<html><head><title>t</title></head><body>${body}</body></html>`,
  headers: { 'content-type': 'text/html' },
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-guards-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'guards', workflow: 'visitor' });
  routes = {};
});

/** Visits `url`, then records that it got past the visit. */
function visitor(url: string, options: VisitOptions = {}) {
  let reachedAfterVisit = false;
  const definition = workflow({
    name: 'visitor',
    async run(ctx) {
      const visit: VisitResult = await ctx.visit(url, options);
      reachedAfterVisit = true;
      await visit.page.close();
      return { offSite: visit.offSite, ok: visit.navigation.ok };
    },
  });
  return { definition, reachedAfterVisit: () => reachedAfterVisit };
}

function run(definition: ReturnType<typeof visitor>['definition']) {
  return runWorkflow(definition, {
    store,
    job,
    browser: new FakeBackend({ routes }),
    dataDir,
    onLine: () => undefined,
  });
}

const eventTypes = (runId: string) => store.events.listByRun(runId).map((event) => event.type);

describe('a site refusing us, met on a plain visit', () => {
  it('stops the run on a 403, without the workflow calling recover()', async () => {
    serve(`${SITE}/private`, html('Access denied', 403));
    const { definition, reachedAfterVisit } = visitor(`${SITE}/private`);

    const outcome = await run(definition);

    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('blocked:http-forbidden');
    expect(reachedAfterVisit()).toBe(false);
    expect(eventTypes(outcome.run.id)).toContain('BLOCKED');
    expect(store.pages.get(job.id, canonicalizeUrlOrThrow(`${SITE}/private`))?.lastError).toBe(
      'blocked: http-forbidden',
    );
  });

  it('stops on a 429 as a rate limit', async () => {
    serve(`${SITE}/busy`, html('Too many requests', 429));
    const outcome = await run(visitor(`${SITE}/busy`).definition);
    expect(outcome.run.stopReason).toBe('blocked:rate-limited');
  });

  it('stops on a DataDome interstitial served with a 200', async () => {
    serve(
      `${SITE}/listing`,
      html('<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe>'),
    );
    const outcome = await run(visitor(`${SITE}/listing`).definition);
    expect(outcome.run.stopReason).toBe('blocked:captcha');
  });

  it('does not mistake an article that mentions a captcha for a challenge', async () => {
    serve(`${SITE}/blog`, html('<p>How a captcha works, and why rate limits exist.</p>'));
    const { definition, reachedAfterVisit } = visitor(`${SITE}/blog`);

    const outcome = await run(definition);

    expect(outcome.run.stopReason).toBe('done');
    expect(reachedAfterVisit()).toBe(true);
  });

  it('still records a 404 as a gone page and carries on', async () => {
    const { definition, reachedAfterVisit } = visitor(`${SITE}/missing`);
    const outcome = await run(definition);

    expect(outcome.run.stopReason).toBe('done');
    expect(reachedAfterVisit()).toBe(true);
    expect(store.pages.get(job.id, canonicalizeUrlOrThrow(`${SITE}/missing`))?.status).toBe('gone');
  });
});

describe('a login wall where a members-only page should be', () => {
  const MY_SEARCHES = `${SITE}/my-searches`;
  const LOGIN = 'http://auth.site.test/login';

  it('stops the run with auth-required when redirected to the login host', async () => {
    serve(MY_SEARCHES, { redirectTo: LOGIN });
    serve(LOGIN, html('<h1>Connectez-vous</h1>'));
    const { definition, reachedAfterVisit } = visitor(MY_SEARCHES, {
      session: { expectHost: 'www.site.test' },
    });

    const outcome = await run(definition);

    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.stopReason).toBe('auth-required');
    expect(outcome.authRequired?.finalUrl).toBe(LOGIN);
    expect(reachedAfterVisit()).toBe(false);

    const event = store.events
      .listByRun(outcome.run.id)
      .find((candidate) => candidate.type === 'AUTH_REQUIRED');
    expect(event?.level).toBe('error');
    // The login page was never stored as the content of the members-only URL.
    expect(store.pages.get(job.id, canonicalizeUrlOrThrow(MY_SEARCHES))?.contentHash ?? null).toBe(
      null,
    );
  });

  it('recognises a login wall rendered in place', async () => {
    serve(MY_SEARCHES, html('<form id="login-form"><input type="password"></form>'));
    const outcome = await run(
      visitor(MY_SEARCHES, {
        waitFor: '.saved-searches',
        session: { expectHost: 'site.test', loginSelector: '#login-form' },
      }).definition,
    );

    // Not a failed run for a missing selector: the precise reason wins.
    expect(outcome.run.stopReason).toBe('auth-required');
    expect(outcome.error).toBeNull();
  });

  it('visits normally while the session holds', async () => {
    serve(MY_SEARCHES, html('<ul class="saved-searches"><li>Vélo</li></ul>'));
    const { definition, reachedAfterVisit } = visitor(MY_SEARCHES, {
      waitFor: '.saved-searches',
      session: { expectHost: 'www.site.test', loginSelector: '#login-form' },
    });

    const outcome = await run(definition);

    expect(outcome.run.stopReason).toBe('done');
    expect(reachedAfterVisit()).toBe(true);
    expect(outcome.authRequired).toBeNull();
  });
});

describe('a redirect to another site', () => {
  it('is recorded as an error against the page, not as its content', async () => {
    serve(`${SITE}/go`, { redirectTo: 'http://elsewhere.test/landing' });
    serve('http://elsewhere.test/landing', html('Somebody else'));

    const outcome = await run(visitor(`${SITE}/go`).definition);

    expect(outcome.result).toEqual({ offSite: true, ok: true });
    const page = store.pages.get(job.id, canonicalizeUrlOrThrow(`${SITE}/go`));
    expect(page?.status).toBe('error');
    expect(page?.contentHash).toBeNull();
    expect(eventTypes(outcome.run.id)).not.toContain('PAGE_VISITED');
  });

  it('does not treat www and the bare domain as two sites', async () => {
    serve(`${SITE}/moved`, { redirectTo: 'http://site.test/moved' });
    serve('http://site.test/moved', html('Here'));

    const outcome = await run(visitor(`${SITE}/moved`).definition);

    expect(outcome.result).toEqual({ offSite: false, ok: true });
    expect(eventTypes(outcome.run.id)).toContain('PAGE_VISITED');
  });
});

describe('pages a workflow forgets to close', () => {
  it('are closed when the run ends, even when the workflow threw', async () => {
    serve(`${SITE}/a`, html('a'));
    let leaked: PageHandle | null = null;

    const outcome = await run(
      workflow({
        name: 'visitor',
        async run(ctx) {
          leaked = (await ctx.visit(`${SITE}/a`)).page;
          throw new Error('workflow bug before its finally');
        },
      }),
    );

    expect(outcome.run.status).toBe('failed');
    expect((leaked as PageHandle | null)?.isClosed()).toBe(true);
    const failed = store.events
      .listByRun(outcome.run.id)
      .find((event) => event.type === 'RUN_FAILED');
    expect(failed?.data).toMatchObject({ leakedPages: 1 });
  });
});
