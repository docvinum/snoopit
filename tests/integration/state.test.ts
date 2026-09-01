import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/state/store.js';
import { contentHash } from '../../src/util/hash.js';
import { isoFromNow, nowIso } from '../../src/util/time.js';

let store: Store;

function seedJob(): string {
  return store.jobs.upsert({ name: 'Demo Job', workflow: 'demo.ts' }).id;
}

beforeEach(() => {
  store = Store.memory();
});

describe('JobRepository', () => {
  it('creates a job with a slugified id and sensible defaults', () => {
    const job = store.jobs.upsert({ name: 'Demo Job', workflow: 'demo.ts' });
    expect(job.id).toBe('demo-job');
    expect(job.browserProfile).toBe('desktop-chrome');
    expect(job.networkProfile).toBe('direct');
    expect(job.enabled).toBe(true);
    expect(job.schedule).toBeNull();
  });

  it('round-trips schedule and budget through JSON columns', () => {
    const job = store.jobs.upsert({
      name: 'Scheduled',
      workflow: 'w.ts',
      schedule: { frequency: 'daily', window: { from: '08:00', to: '10:00' } },
      budget: { maxPages: 50, maxDuration: '20m' },
    });
    const reloaded = store.jobs.get(job.id)!;
    expect(reloaded.schedule).toEqual({
      frequency: 'daily',
      window: { from: '08:00', to: '10:00' },
    });
    expect(reloaded.budget).toEqual({ maxPages: 50, maxDuration: '20m' });
  });

  it('upserts rather than duplicating, keeping created_at', () => {
    const first = store.jobs.upsert({ name: 'Demo Job', workflow: 'a.ts' });
    const second = store.jobs.upsert({ name: 'Demo Job', workflow: 'b.ts' });
    expect(second.id).toBe(first.id);
    expect(second.workflow).toBe('b.ts');
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.jobs.list()).toHaveLength(1);
  });

  it('filters disabled jobs on request', () => {
    const id = seedJob();
    store.jobs.upsert({ name: 'Other', workflow: 'o.ts' });
    store.jobs.setEnabled(id, false);
    expect(store.jobs.list()).toHaveLength(2);
    expect(store.jobs.list({ enabledOnly: true }).map((j) => j.id)).toEqual(['other']);
  });

  it('cascades deletion to dependent rows', () => {
    const id = seedJob();
    store.runs.start({ jobId: id, trigger: 'manual' });
    store.pages.discover({ jobId: id, url: 'https://e.com/a', canonicalUrl: 'https://e.com/a' });
    store.jobs.delete(id);
    expect(store.runs.listByJob(id)).toHaveLength(0);
    expect(store.pages.countByStatus(id)).toEqual({});
  });
});

describe('RunRepository', () => {
  it('starts a run in the running state with a heartbeat', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'schedule', budget: { maxPages: 10 } });
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('schedule');
    expect(run.heartbeatAt).not.toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.budget).toEqual({ maxPages: 10 });
    expect(run.counters.pagesVisited).toBe(0);
  });

  it('produces sortable, unique run ids', () => {
    const jobId = seedJob();
    const ids = new Set(
      Array.from({ length: 50 }, () => store.runs.start({ jobId, trigger: 'manual' }).id),
    );
    expect(ids.size).toBe(50);
  });

  it('increments counters independently', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    store.runs.increment(run.id, 'pagesVisited', 3);
    store.runs.increment(run.id, 'pagesVisited');
    store.runs.increment(run.id, 'downloadedBytes', 2048);
    store.runs.increment(run.id, 'llmCalls');

    const counters = store.runs.get(run.id)!.counters;
    expect(counters.pagesVisited).toBe(4);
    expect(counters.downloadedBytes).toBe(2048);
    expect(counters.llmCalls).toBe(1);
    expect(counters.errorCount).toBe(0);
  });

  it('records why a run stopped', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    const finished = store.runs.finish(run.id, {
      status: 'completed',
      stopReason: 'budget:max_pages',
      reportPath: 'jobs/demo-job/runs/x/report.md',
    })!;
    expect(finished.status).toBe('completed');
    expect(finished.stopReason).toBe('budget:max_pages');
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.reportPath).toBe('jobs/demo-job/runs/x/report.md');
  });

  it('finds runs whose heartbeat went stale — the crash signature', () => {
    const jobId = seedJob();
    const alive = store.runs.start({ jobId, trigger: 'manual' });
    const crashed = store.runs.start({ jobId, trigger: 'manual' });
    // Simulate a process killed mid-run: status stays `running`, heartbeat stops.
    store.runs.heartbeat(crashed.id, isoFromNow(-10 * 60_000));

    const stale = store.runs.findStale(isoFromNow(-60_000));
    expect(stale.map((r) => r.id)).toEqual([crashed.id]);
    expect(stale.map((r) => r.id)).not.toContain(alive.id);
  });

  it('does not report finished runs as stale', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    store.runs.heartbeat(run.id, isoFromNow(-10 * 60_000));
    store.runs.finish(run.id, { status: 'completed', stopReason: 'done' });
    expect(store.runs.findStale(isoFromNow(-60_000))).toHaveLength(0);
  });
});

describe('PageRepository', () => {
  const URL_A = 'https://example.com/a';

  it('records discovery idempotently and preserves first_seen_at', () => {
    const jobId = seedJob();
    const first = store.pages.discover({ jobId, url: URL_A, canonicalUrl: URL_A });
    const again = store.pages.discover({ jobId, url: URL_A, canonicalUrl: URL_A });

    expect(again.id).toBe(first.id);
    expect(again.firstSeenAt).toBe(first.firstSeenAt);
    expect(again.status).toBe('discovered');
    expect(again.visitCount).toBe(0);
    expect(store.pages.countByStatus(jobId)).toEqual({ discovered: 1 });
  });

  it('treats different canonical URLs as different pages', () => {
    const jobId = seedJob();
    store.pages.discover({ jobId, url: URL_A, canonicalUrl: URL_A });
    store.pages.discover({ jobId, url: `${URL_A}/b`, canonicalUrl: `${URL_A}/b` });
    expect(store.pages.countByStatus(jobId)).toEqual({ discovered: 2 });
  });

  it('reports the first visit as unchanged', () => {
    const jobId = seedJob();
    const result = store.pages.recordVisit({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      contentHash: contentHash('v1'),
      httpStatus: 200,
      title: 'A',
    });
    expect(result.firstVisit).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.page.status).toBe('visited');
    expect(result.page.visitCount).toBe(1);
    expect(result.page.lastChangedAt).toBeNull();
  });

  it('detects a changed body on a later visit', () => {
    const jobId = seedJob();
    store.pages.recordVisit({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      contentHash: contentHash('v1'),
    });
    const second = store.pages.recordVisit({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      contentHash: contentHash('v2'),
    });

    expect(second.changed).toBe(true);
    expect(second.firstVisit).toBe(false);
    expect(second.page.status).toBe('changed');
    expect(second.page.visitCount).toBe(2);
    expect(second.page.lastChangedAt).not.toBeNull();
  });

  it('reports an identical body as unchanged', () => {
    const jobId = seedJob();
    const hash = contentHash('same');
    store.pages.recordVisit({ jobId, url: URL_A, canonicalUrl: URL_A, contentHash: hash });
    const second = store.pages.recordVisit({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      contentHash: hash,
    });
    expect(second.changed).toBe(false);
    expect(second.page.status).toBe('visited');
  });

  it('keeps the previous hash when a visit yields none', () => {
    const jobId = seedJob();
    const hash = contentHash('v1');
    store.pages.recordVisit({ jobId, url: URL_A, canonicalUrl: URL_A, contentHash: hash });
    const second = store.pages.recordVisit({ jobId, url: URL_A, canonicalUrl: URL_A });
    expect(second.page.contentHash).toBe(hash);
    expect(second.changed).toBe(false);
  });

  it('accumulates an error streak and clears it on success', () => {
    const jobId = seedJob();
    store.pages.recordError({ jobId, url: URL_A, canonicalUrl: URL_A, error: 'timeout' });
    const twice = store.pages.recordError({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      error: 'timeout again',
      httpStatus: 503,
    });
    expect(twice.errorCount).toBe(2);
    expect(twice.status).toBe('error');
    expect(twice.lastError).toBe('timeout again');

    // A page that failed yesterday and works today is simply working.
    const recovered = store.pages.recordVisit({ jobId, url: URL_A, canonicalUrl: URL_A });
    expect(recovered.page.errorCount).toBe(0);
    expect(recovered.page.lastError).toBeNull();
    expect(recovered.page.status).toBe('visited');
  });

  it('marks a page gone without losing its history', () => {
    const jobId = seedJob();
    store.pages.recordVisit({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      contentHash: contentHash('v1'),
    });
    const gone = store.pages.markGone(jobId, URL_A, 404)!;
    expect(gone.status).toBe('gone');
    expect(gone.httpStatus).toBe(404);
    expect(gone.visitCount).toBe(1);
    expect(gone.firstSeenAt).not.toBeNull();
  });

  it('returns only pages whose revisit time has come, excluding gone ones', () => {
    const jobId = seedJob();
    store.pages.recordVisit({
      jobId,
      url: `${URL_A}/due`,
      canonicalUrl: `${URL_A}/due`,
      nextVisitAfter: isoFromNow(-60_000),
    });
    store.pages.recordVisit({
      jobId,
      url: `${URL_A}/later`,
      canonicalUrl: `${URL_A}/later`,
      nextVisitAfter: isoFromNow(3_600_000),
    });
    store.pages.recordVisit({
      jobId,
      url: `${URL_A}/never`,
      canonicalUrl: `${URL_A}/never`,
    });
    store.pages.recordVisit({
      jobId,
      url: `${URL_A}/dead`,
      canonicalUrl: `${URL_A}/dead`,
      nextVisitAfter: isoFromNow(-60_000),
    });
    store.pages.markGone(jobId, `${URL_A}/dead`);

    expect(store.pages.dueForRevisit(jobId, nowIso()).map((p) => p.canonicalUrl)).toEqual([
      `${URL_A}/due`,
    ]);
  });
});

describe('FrontierRepository', () => {
  const URL_A = 'https://example.com/a';

  it('reports whether an enqueue created a new entry', () => {
    const jobId = seedJob();
    expect(store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A })).toBe(true);
    expect(store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A })).toBe(false);
    expect(store.frontier.countByState(jobId)).toEqual({ queued: 1 });
  });

  it('deduplicates repeated discovery within the same millisecond', () => {
    const jobId = seedJob();
    const created = Array.from({ length: 20 }, () =>
      store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A }),
    ).filter(Boolean);
    expect(created).toHaveLength(1);
    expect(store.frontier.remaining(jobId)).toBe(1);
  });

  it('never resets an already-worked entry back to queued', () => {
    // This is what stops a crawl looping over a URL linked from every page.
    const jobId = seedJob();
    store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A });
    store.frontier.setState(jobId, URL_A, 'done');
    store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A });
    expect(store.frontier.get(jobId, URL_A)!.state).toBe('done');
    expect(store.frontier.remaining(jobId)).toBe(0);
  });

  it('raises priority on re-discovery but never lowers it', () => {
    const jobId = seedJob();
    store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A, priority: 50 });
    store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A, priority: 90 });
    expect(store.frontier.get(jobId, URL_A)!.priority).toBe(50);
    store.frontier.enqueue({ jobId, url: URL_A, canonicalUrl: URL_A, priority: 10 });
    expect(store.frontier.get(jobId, URL_A)!.priority).toBe(10);
  });

  it('orders by priority, then depth, then insertion', () => {
    const jobId = seedJob();
    store.frontier.enqueue({ jobId, url: 'u/1', canonicalUrl: 'u/1', priority: 100, depth: 1 });
    store.frontier.enqueue({ jobId, url: 'u/2', canonicalUrl: 'u/2', priority: 10, depth: 5 });
    store.frontier.enqueue({ jobId, url: 'u/3', canonicalUrl: 'u/3', priority: 100, depth: 0 });
    store.frontier.enqueue({ jobId, url: 'u/4', canonicalUrl: 'u/4', priority: 100, depth: 1 });

    expect(store.frontier.peek(jobId).map((e) => e.canonicalUrl)).toEqual([
      'u/2',
      'u/3',
      'u/1',
      'u/4',
    ]);
  });

  it('hides entries that are not yet available', () => {
    const jobId = seedJob();
    store.frontier.enqueue({ jobId, url: 'u/now', canonicalUrl: 'u/now' });
    store.frontier.enqueue({
      jobId,
      url: 'u/later',
      canonicalUrl: 'u/later',
      availableAfter: isoFromNow(3_600_000),
    });
    expect(store.frontier.peek(jobId).map((e) => e.canonicalUrl)).toEqual(['u/now']);
    expect(store.frontier.remaining(jobId)).toBe(2);
  });

  it('round-trips metadata', () => {
    const jobId = seedJob();
    store.frontier.enqueue({
      jobId,
      url: URL_A,
      canonicalUrl: URL_A,
      kind: 'document',
      meta: { title: 'Rapport 2026', pages: 12 },
    });
    const entry = store.frontier.get(jobId, URL_A)!;
    expect(entry.kind).toBe('document');
    expect(entry.meta).toEqual({ title: 'Rapport 2026', pages: 12 });
  });

  it('counts only unfinished work as remaining', () => {
    const jobId = seedJob();
    store.frontier.enqueue({ jobId, url: 'u/1', canonicalUrl: 'u/1' });
    store.frontier.enqueue({ jobId, url: 'u/2', canonicalUrl: 'u/2' });
    store.frontier.enqueue({ jobId, url: 'u/3', canonicalUrl: 'u/3' });
    store.frontier.setState(jobId, 'u/1', 'done');
    store.frontier.setState(jobId, 'u/2', 'failed', 'boom');
    expect(store.frontier.remaining(jobId)).toBe(1);
    expect(store.frontier.get(jobId, 'u/2')!.lastError).toBe('boom');
  });
});

describe('ArtifactRepository', () => {
  it('links an artifact to its job, run, page and source URL', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    const page = store.pages.discover({
      jobId,
      url: 'https://e.com/pub',
      canonicalUrl: 'https://e.com/pub',
    });

    const artifact = store.artifacts.create({
      jobId,
      runId: run.id,
      pageId: page.id,
      sourceUrl: 'https://e.com/pub/report.pdf',
      canonicalUrl: 'https://e.com/pub/report.pdf',
      kind: 'pdf',
      path: 'jobs/demo-job/artifacts/report.pdf',
      mediaType: 'application/pdf',
      bytes: 1024,
      contentHash: contentHash('pdf-bytes'),
      meta: { title: 'Rapport' },
    });

    expect(artifact.runId).toBe(run.id);
    expect(artifact.pageId).toBe(page.id);
    expect(artifact.meta).toEqual({ title: 'Rapport' });
    expect(store.artifacts.listByRun(run.id)).toHaveLength(1);
  });

  it('finds artifacts by content hash for deduplication', () => {
    const jobId = seedJob();
    const hash = contentHash('identical-bytes');
    store.artifacts.create({ jobId, kind: 'pdf', path: 'a.pdf', contentHash: hash });
    store.artifacts.create({ jobId, kind: 'pdf', path: 'b.pdf', contentHash: hash });
    store.artifacts.create({
      jobId,
      kind: 'pdf',
      path: 'c.pdf',
      contentHash: contentHash('other'),
    });

    expect(store.artifacts.findByHash(jobId, hash).map((a) => a.path)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('sums downloaded bytes for a run', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    store.artifacts.create({ jobId, runId: run.id, kind: 'pdf', path: 'a.pdf', bytes: 1000 });
    store.artifacts.create({ jobId, runId: run.id, kind: 'pdf', path: 'b.pdf', bytes: 2500 });
    store.artifacts.create({ jobId, runId: run.id, kind: 'markdown', path: 'r.md' });
    expect(store.artifacts.totalBytes(run.id)).toBe(3500);
  });

  it('survives its run being deleted, keeping job provenance', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    const artifact = store.artifacts.create({ jobId, runId: run.id, kind: 'pdf', path: 'a.pdf' });
    store.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);
    const reloaded = store.artifacts.get(artifact.id)!;
    expect(reloaded.runId).toBeNull();
    expect(reloaded.jobId).toBe(jobId);
  });
});

describe('EventRepository', () => {
  it('appends events in order with defaults', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    store.events.append({ jobId, runId: run.id, type: 'RUN_STARTED' });
    store.events.append({
      jobId,
      runId: run.id,
      type: 'PAGE_VISITED',
      url: 'https://e.com/a',
      canonicalUrl: 'https://e.com/a',
      data: { httpStatus: 200 },
    });
    store.events.append({
      jobId,
      runId: run.id,
      type: 'HTTP_ERROR',
      level: 'error',
      message: '404 on /missing',
    });

    const events = store.events.listByRun(run.id);
    expect(events.map((e) => e.type)).toEqual(['RUN_STARTED', 'PAGE_VISITED', 'HTTP_ERROR']);
    expect(events[0]!.level).toBe('info');
    expect(events[1]!.data).toEqual({ httpStatus: 200 });
    expect(events[2]!.level).toBe('error');
  });

  it('counts events by type for the run report', () => {
    const jobId = seedJob();
    const run = store.runs.start({ jobId, trigger: 'manual' });
    for (let i = 0; i < 3; i += 1) {
      store.events.append({ jobId, runId: run.id, type: 'PAGE_VISITED' });
    }
    store.events.append({ jobId, runId: run.id, type: 'BUDGET_REACHED' });
    expect(store.events.countByType(run.id)).toEqual({ PAGE_VISITED: 3, BUDGET_REACHED: 1 });
  });

  it('is not scoped to a run — job-level history outlives any single run', () => {
    const jobId = seedJob();
    const first = store.runs.start({ jobId, trigger: 'manual' });
    const second = store.runs.start({ jobId, trigger: 'manual' });
    store.events.append({ jobId, runId: first.id, type: 'CONTENT_CHANGED' });
    store.events.append({ jobId, runId: second.id, type: 'CONTENT_CHANGED' });
    expect(store.events.listByType(jobId, 'CONTENT_CHANGED')).toHaveLength(2);
  });
});

describe('Store transactions', () => {
  it('rolls back every write when the callback throws', () => {
    const jobId = seedJob();
    expect(() =>
      store.transaction((tx) => {
        tx.frontier.enqueue({ jobId, url: 'u/1', canonicalUrl: 'u/1' });
        tx.pages.discover({ jobId, url: 'u/1', canonicalUrl: 'u/1' });
        throw new Error('workflow failed halfway');
      }),
    ).toThrow('workflow failed halfway');

    expect(store.frontier.remaining(jobId)).toBe(0);
    expect(store.pages.countByStatus(jobId)).toEqual({});
  });
});

describe('cross-job isolation', () => {
  it('keeps identical URLs in different jobs separate', () => {
    const a = store.jobs.upsert({ name: 'Job A', workflow: 'a.ts' }).id;
    const b = store.jobs.upsert({ name: 'Job B', workflow: 'b.ts' }).id;
    const url = 'https://example.com/shared';

    store.pages.recordVisit({ jobId: a, url, canonicalUrl: url, contentHash: contentHash('a') });
    store.pages.recordVisit({ jobId: b, url, canonicalUrl: url, contentHash: contentHash('b') });

    expect(store.pages.get(a, url)!.contentHash).not.toBe(store.pages.get(b, url)!.contentHash);
    expect(store.frontier.enqueue({ jobId: a, url, canonicalUrl: url })).toBe(true);
    expect(store.frontier.enqueue({ jobId: b, url, canonicalUrl: url })).toBe(true);
  });
});

describe('the memory of the system', () => {
  it('remembers a page across independent runs — the property Lot 0 found missing', () => {
    const jobId = seedJob();
    const url = 'https://example.com/publications';

    const firstRun = store.runs.start({ jobId, trigger: 'schedule' });
    store.pages.recordVisit({ jobId, url, canonicalUrl: url, contentHash: contentHash('v1') });
    store.runs.finish(firstRun.id, { status: 'completed', stopReason: 'done' });

    // A second run, as if the process had been restarted entirely.
    const secondRun = store.runs.start({ jobId, trigger: 'schedule' });
    const revisit = store.pages.recordVisit({
      jobId,
      url,
      canonicalUrl: url,
      contentHash: contentHash('v2'),
    });
    store.runs.finish(secondRun.id, { status: 'completed', stopReason: 'done' });

    expect(revisit.changed).toBe(true);
    expect(revisit.page.visitCount).toBe(2);
    expect(revisit.page.firstSeenAt <= revisit.page.lastVisitedAt!).toBe(true);
    expect(store.runs.listByJob(jobId)).toHaveLength(2);
  });
});
