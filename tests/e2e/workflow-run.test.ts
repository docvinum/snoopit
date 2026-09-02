/**
 * The Lot 3 acceptance criterion, executed.
 *
 * discovery -> navigation -> extraction -> download -> persistence -> report,
 * in one pass, producing correct artifacts with their provenance.
 *
 * Run against both backends: the fake proves the chain is browser-independent, the
 * real Chrome proves it survives contact with a browser. Fixtures are served
 * locally; no test touches a third-party site.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpBackend } from '../../src/runtime/browser/cdp.js';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import type { BrowserBackend } from '../../src/runtime/browser/types.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import { contentHash } from '../../src/util/hash.js';
import { buildFakeSite } from '../support/fake-site.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const CDP_URL = process.env['SNOOPIT_TEST_CDP_URL'] ?? 'http://127.0.0.1:9222';

let server: FixtureServer;
let hasChrome = false;

beforeAll(async () => {
  server = await startFixtureServer();
  try {
    const probe = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    hasChrome = probe.ok;
  } catch {
    hasChrome = false;
  }
});

afterAll(async () => {
  await server.close();
});

/** The collect workflow under test, parameterised by start URL so fixtures can move. */
function publicationsWorkflow(startUrl: string) {
  return workflow({
    name: 'test-publications',
    type: 'collect',
    budget: { maxPages: 20, maxLlmCalls: 0 },

    async run(ctx) {
      // ── Discovery ─────────────────────────────────────────────────────────
      const { page, changed, firstVisit } = await ctx.visit(startUrl, {
        waitFor: '.publication-list',
      });

      const banner = await page.query('#cookie-banner');
      if (banner !== null && banner.view.display !== 'none') {
        await page.click('#accept-cookies');
      }

      const publications = await ctx.extract(page, {
        selector: '.publication',
        fields: { title: '.title', date: '.date', pdf: '.download@href' },
      });

      for (const publication of publications) {
        if (publication.pdf === null) continue;
        ctx.frontier.discover(publication.pdf, {
          kind: 'document',
          meta: { title: publication.title, date: publication.date },
        });
      }
      await page.close();

      // ── Collection ────────────────────────────────────────────────────────
      const collector = await ctx.browser.open(startUrl);
      const collected: string[] = [];
      try {
        for (const entry of ctx.frontier.take(20)) {
          const { artifact, deduplicated } = await ctx.artifacts.collect(collector, entry.url, {
            dir: 'publications',
          });
          if (!deduplicated) collected.push(artifact.path);
          ctx.frontier.complete(entry);
        }
      } finally {
        await collector.close();
      }

      await ctx.artifacts.writeJson('publications.json', { collected });

      return { seen: publications.length, collected: collected.length, changed, firstVisit };
    },
  });
}

interface Harness {
  readonly name: string;
  readonly isReal: boolean;
  create(): Promise<BrowserBackend>;
}

const HARNESSES: Harness[] = [
  {
    name: 'FakeBackend',
    isReal: false,
    create: () => Promise.resolve(new FakeBackend(buildFakeSite(server.origin))),
  },
  {
    name: 'CdpBackend',
    isReal: true,
    create: () => CdpBackend.connect({ cdpUrl: CDP_URL, defaultTimeoutMs: 10_000 }),
  },
];

for (const harness of HARNESSES) {
  describe(`end-to-end run (${harness.name})`, () => {
    const runs = (): boolean => !harness.isReal || hasChrome;

    /** Fresh data dir and database per case: a run must not depend on test order. */
    async function withRun<T>(
      fn: (args: {
        store: Store;
        dataDir: string;
        backend: BrowserBackend;
        startUrl: string;
      }) => Promise<T>,
    ): Promise<T> {
      const dataDir = mkdtempSync(join(tmpdir(), 'snoopit-e2e-'));
      const store = Store.open({ path: join(dataDir, 'snoopit.db') });
      const backend = await harness.create();
      try {
        return await fn({ store, dataDir, backend, startUrl: server.url('/index.html') });
      } finally {
        await backend.close();
        store.close();
      }
    }

    it('runs the whole chain and writes both reports', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-pubs', workflow: 'test-publications' });

        const outcome = await runWorkflow(publicationsWorkflow(startUrl), {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        expect(outcome.error).toBeNull();
        expect(outcome.run.status).toBe('completed');
        expect(outcome.run.stopReason).toBe('done');
        expect(outcome.result).toMatchObject({ seen: 3, collected: 2, firstVisit: true });

        const markdown = readFileSync(resolve(dataDir, outcome.reportPath), 'utf8');
        const json: unknown = JSON.parse(
          readFileSync(resolve(dataDir, outcome.reportJsonPath), 'utf8'),
        );

        expect(markdown).toContain('# Rapport de run');
        expect(markdown).toContain(outcome.run.id);
        expect(json).toMatchObject({ run: { status: 'completed' }, counters: { llmCalls: 0 } });
      });
    });

    it('downloads byte-identical documents to deterministic paths', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-bytes', workflow: 'test-publications' });
        const outcome = await runWorkflow(publicationsWorkflow(startUrl), {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        const pdfs = store.artifacts.listByRun(outcome.run.id).filter((a) => a.kind === 'pdf');
        expect(pdfs).toHaveLength(2);

        for (const artifact of pdfs) {
          const bytes = readFileSync(resolve(dataDir, artifact.path));
          expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
          // Provenance is only meaningful if the hash matches what is on disk.
          expect(contentHash(bytes)).toBe(artifact.contentHash);
          expect(artifact.bytes).toBe(bytes.byteLength);
        }

        const source = readFileSync('tests/fixtures/site/publications/rapport-2026.pdf');
        expect(pdfs.map((a) => a.contentHash)).toContain(contentHash(source));
      });
    });

    it('records provenance linking each artifact to its job, run, page and URL', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-prov', workflow: 'test-publications' });
        const outcome = await runWorkflow(publicationsWorkflow(startUrl), {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        const pdf = store.artifacts.listByRun(outcome.run.id).find((a) => a.kind === 'pdf')!;
        expect(pdf.jobId).toBe(job.id);
        expect(pdf.runId).toBe(outcome.run.id);
        expect(pdf.sourceUrl).toContain('/publications/');
        expect(pdf.canonicalUrl).not.toBeNull();
        expect(pdf.mediaType).toBe('application/pdf');

        // The page row it came from carries the discovery date.
        expect(pdf.pageId).not.toBeNull();
        const page = store.db
          .prepare('SELECT canonical_url, first_seen_at FROM crawl_pages WHERE id = ?')
          .get(pdf.pageId) as { canonical_url: string; first_seen_at: string };
        expect(page.canonical_url).toBe(pdf.canonicalUrl);
        expect(page.first_seen_at).not.toBe('');
      });
    });

    it('emits the events that make the run explainable', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-events', workflow: 'test-publications' });
        const outcome = await runWorkflow(publicationsWorkflow(startUrl), {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        const counts = store.events.countByType(outcome.run.id);
        expect(counts['RUN_STARTED']).toBe(1);
        expect(counts['PAGE_VISITED']).toBe(1);
        expect(counts['PAGE_DISCOVERED']).toBe(2);
        expect(counts['ARTIFACT_CREATED']).toBe(3);
        expect(counts['RUN_COMPLETED']).toBe(1);

        // events.jsonl is appended as it happens, so a killed run still leaves a trace.
        const jsonl = readFileSync(
          resolve(dataDir, 'jobs', job.id, 'runs', outcome.run.id, 'events.jsonl'),
          'utf8',
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type: string });

        expect(jsonl[0]!.type).toBe('RUN_STARTED');
        expect(jsonl.at(-1)!.type).toBe('RUN_COMPLETED');
      });
    });

    it('remembers across runs: a second run re-collects nothing', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-memory', workflow: 'test-publications' });
        const definition = publicationsWorkflow(startUrl);
        const options = { store, job, browser: backend, dataDir, onLine: () => undefined };

        const first = await runWorkflow(definition, options);
        expect(first.result).toMatchObject({ collected: 2, firstVisit: true });

        // The property the audited project could not provide at all.
        const second = await runWorkflow(definition, options);
        expect(second.result).toMatchObject({ collected: 0, firstVisit: false, changed: false });
        expect(second.run.id).not.toBe(first.run.id);

        expect(store.events.countByType(second.run.id)['PAGE_DISCOVERED']).toBeUndefined();
        expect(
          store.artifacts.listByRun(second.run.id).filter((a) => a.kind === 'pdf'),
        ).toHaveLength(0);
        expect(store.runs.listByJob(job.id)).toHaveLength(2);
      });
    });

    it('closes and reports a run even when the workflow throws', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend, startUrl }) => {
        const job = store.jobs.upsert({ name: 'e2e-fail', workflow: 'broken' });
        const broken = workflow({
          name: 'broken',
          async run(ctx) {
            const { page } = await ctx.visit(startUrl);
            await page.close();
            throw new Error('deliberate failure');
          },
        });

        const outcome = await runWorkflow(broken, {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        // An unexplained run is a defect, not an edge case.
        expect(outcome.error?.message).toBe('deliberate failure');
        expect(outcome.run.status).toBe('failed');
        expect(outcome.run.stopReason).toBe('error');
        expect(outcome.run.finishedAt).not.toBeNull();

        const markdown = readFileSync(resolve(dataDir, outcome.reportPath), 'utf8');
        expect(markdown).toContain('## Erreur fatale');
        expect(markdown).toContain('deliberate failure');
        expect(store.events.countByType(outcome.run.id)['RUN_FAILED']).toBe(1);
      });
    });

    it('records an HTTP error against the page instead of hashing the error body', async () => {
      if (!runs()) return;
      await withRun(async ({ store, dataDir, backend }) => {
        const job = store.jobs.upsert({ name: 'e2e-404', workflow: 'audit' });
        const missing = server.url('/missing.html');

        const auditing = workflow({
          name: 'audit',
          async run(ctx) {
            const { page, navigation } = await ctx.visit(missing);
            await page.close();
            return { status: navigation.status };
          },
        });

        const outcome = await runWorkflow(auditing, {
          store,
          job,
          browser: backend,
          dataDir,
          onLine: () => undefined,
        });

        expect(outcome.result).toEqual({ status: 404 });
        expect(store.events.countByType(outcome.run.id)['HTTP_ERROR']).toBe(1);

        // A 404 body must never be recorded as content: it would look like a change.
        const page = store.pages.get(job.id, missing)!;
        expect(page.status).toBe('gone');
        expect(page.contentHash).toBeNull();
        expect(outcome.run.counters.pagesVisited).toBe(0);
        expect(outcome.run.counters.errorCount).toBe(1);
      });
    });
  });
}
