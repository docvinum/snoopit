/**
 * Collecting documents across runs: what happens to files already on disk.
 *
 * Provenance is only worth something if the bytes an artifact row describes are
 * the bytes on disk. These tests pin that, and pin that deduplication neither
 * rewrites files nor escapes the budget.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeResponse } from '../../src/runtime/browser/fake.js';
import { canonicalizeUrlOrThrow } from '../../src/runtime/navigation/canonical.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job, RunBudget } from '../../src/state/types.js';
import { contentHash } from '../../src/util/hash.js';

const ORIGIN = 'http://site.test';
const INDEX = `${ORIGIN}/index.html`;

let store: Store;
let dataDir: string;
let job: Job;
let routes: Record<string, FakeResponse>;

function serve(path: string, response: FakeResponse): void {
  routes[canonicalizeUrlOrThrow(`${ORIGIN}${path}`)] = response;
}

const pdf = (text: string): FakeResponse => ({
  status: 200,
  body: Buffer.from(`%PDF-1.4 ${text}`),
  headers: { 'content-type': 'application/pdf' },
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-collect-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'collect-job', workflow: 'collector' });
  routes = {};
  serve('/index.html', { status: 200, body: '<html><body>index</body></html>' });
});

/** Collects each path, once per call to `run`, returning the dedupe flags. */
function collector(paths: readonly string[]) {
  return workflow({
    name: 'collector',
    async run(ctx) {
      const page = await ctx.browser.open(INDEX);
      try {
        const results = [];
        for (const path of paths) {
          results.push(await ctx.artifacts.collect(page, `${ORIGIN}${path}`, { dir: 'docs' }));
        }
        return results.map((result) => ({
          path: result.artifact.path,
          deduplicated: result.deduplicated,
        }));
      } finally {
        await page.close();
      }
    },
  });
}

function run(paths: readonly string[], budget: RunBudget | null = null) {
  return runWorkflow(collector(paths), {
    store,
    job,
    browser: new FakeBackend({ routes }),
    dataDir,
    budget,
    onLine: () => undefined,
  });
}

describe('collecting a document that changed at the same URL', () => {
  it('keeps the earlier version on disk, matching its recorded hash', async () => {
    serve('/rapport.pdf', pdf('version 1'));
    await run(['/rapport.pdf']);

    serve('/rapport.pdf', pdf('version 2'));
    const second = await run(['/rapport.pdf']);
    expect(second.result).toMatchObject([{ deduplicated: false }]);

    const artifacts = store.artifacts.listByJob(job.id);
    expect(artifacts).toHaveLength(2);
    expect(new Set(artifacts.map((artifact) => artifact.path)).size).toBe(2);
    for (const artifact of artifacts) {
      const onDisk = readFileSync(resolve(dataDir, artifact.path));
      expect(contentHash(onDisk)).toBe(artifact.contentHash);
    }
  });

  it('lands the same bytes on the same file every time', async () => {
    serve('/rapport.pdf', pdf('stable'));
    const first = (await run(['/rapport.pdf'])).result as { path: string }[];
    const second = await run(['/rapport.pdf']);

    expect(second.result).toEqual([{ path: first[0]?.path, deduplicated: true }]);
    expect(store.artifacts.listByJob(job.id)).toHaveLength(1);
  });
});

describe('deduplication', () => {
  it('recognises the same bytes republished at another URL, and writes nothing', async () => {
    serve('/a.pdf', pdf('same'));
    serve('/b.pdf', pdf('same'));

    const outcome = await run(['/a.pdf', '/b.pdf']);
    const [a, b] = outcome.result as { path: string; deduplicated: boolean }[];

    expect(a?.deduplicated).toBe(false);
    expect(b).toEqual({ path: a?.path, deduplicated: true });
    expect(store.artifacts.listByJob(job.id)).toHaveLength(1);
  });

  it('still charges the fetch against maxPages, so re-collecting is bounded', async () => {
    serve('/a.pdf', pdf('same'));
    await run(['/a.pdf']);

    const outcome = await run(['/a.pdf', '/a.pdf', '/a.pdf', '/a.pdf'], { maxPages: 2 });

    expect(outcome.run.stopReason).toBe('budget:max_pages');
    expect(outcome.run.counters.downloadedBytes).toBe(2 * pdf('same').body!.length);
  });
});
