import { describe, expect, it } from 'vitest';
import { buildReport, type ReportInput } from '../../src/outputs/report.js';
import type { Artifact, Run, RunEvent } from '../../src/state/types.js';

const RUN: Run = {
  id: '2026-08-31T080000Z-3f9a',
  jobId: 'demo-job',
  status: 'completed',
  trigger: 'schedule',
  startedAt: '2026-08-31T08:00:00.000Z',
  finishedAt: '2026-08-31T08:02:30.000Z',
  heartbeatAt: '2026-08-31T08:02:29.000Z',
  budget: null,
  stopReason: 'done',
  error: null,
  counters: {
    pagesVisited: 12,
    pagesDiscovered: 34,
    artifactsCreated: 3,
    downloadedBytes: 2_097_152,
    llmCalls: 0,
    errorCount: 1,
  },
  reportPath: null,
};

const ARTIFACT: Artifact = {
  id: 1,
  jobId: 'demo-job',
  runId: RUN.id,
  pageId: 7,
  sourceUrl: 'https://e.com/report.pdf',
  canonicalUrl: 'https://e.com/report.pdf',
  kind: 'pdf',
  path: 'jobs/demo-job/artifacts/publications/report-abc123.pdf',
  mediaType: 'application/pdf',
  bytes: 4096,
  contentHash: 'sha256:deadbeef',
  createdAt: '2026-08-31T08:01:00.000Z',
  meta: null,
};

const PROBLEM: RunEvent = {
  id: 9,
  jobId: 'demo-job',
  runId: RUN.id,
  at: '2026-08-31T08:01:30.000Z',
  type: 'HTTP_ERROR',
  level: 'error',
  url: 'https://e.com/missing',
  canonicalUrl: 'https://e.com/missing',
  message: 'HTTP 404',
  data: null,
};

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    run: RUN,
    jobName: 'demo-job',
    workflow: 'example-publications',
    pageCounts: { visited: 12, error: 1 },
    frontierCounts: { done: 12, queued: 22 },
    eventCounts: { PAGE_VISITED: 12, HTTP_ERROR: 1 },
    artifacts: [ARTIFACT],
    problems: [PROBLEM],
    ...overrides,
  };
}

describe('buildReport', () => {
  it('produces valid JSON', () => {
    const parsed: unknown = JSON.parse(buildReport(input()).json);
    expect(parsed).toMatchObject({
      run: { id: RUN.id, status: 'completed', stopReason: 'done' },
      counters: { pagesVisited: 12, llmCalls: 0 },
    });
  });

  it('states the same facts in both forms', () => {
    // A divergence between the human and machine views of a run is the kind of
    // defect nobody notices until it matters, so both come from one function.
    const report = buildReport(input());
    const json = JSON.parse(report.json) as { counters: { pagesVisited: number } };

    expect(json.counters.pagesVisited).toBe(12);
    expect(report.markdown).toContain('| Pages visitées | 12 |');
    expect(report.markdown).toContain(RUN.id);
  });

  it('records the budget in force, so a truncated run explains itself', () => {
    const report = buildReport(input({ budget: { maxPages: 100, maxDuration: '20m' } }));
    expect(report.markdown).toContain('## Budget');
    expect(report.markdown).toContain('`maxPages` | 100');
    expect(JSON.parse(report.json)).toMatchObject({ budget: { maxPages: 100 } });
  });

  it('omits the budget section when there is no budget', () => {
    expect(buildReport(input({ budget: null })).markdown).not.toContain('## Budget');
  });

  it('lists artifacts with their provenance', () => {
    const markdown = buildReport(input()).markdown;
    expect(markdown).toContain(ARTIFACT.path);
    expect(markdown).toContain('https://e.com/report.pdf');
    expect(markdown).toContain('4.0 KB');
  });

  it('carries the content hash into the JSON, for downstream deduplication', () => {
    const json = JSON.parse(buildReport(input()).json) as {
      artifacts: { contentHash: string }[];
    };
    expect(json.artifacts[0]!.contentHash).toBe('sha256:deadbeef');
  });

  it('surfaces problems rather than burying them', () => {
    const markdown = buildReport(input()).markdown;
    expect(markdown).toContain('HTTP_ERROR');
    expect(markdown).toContain('https://e.com/missing');
  });

  it('says so plainly when there is nothing wrong', () => {
    const markdown = buildReport(input({ problems: [] })).markdown;
    expect(markdown).toContain('## Problèmes');
    expect(markdown).toContain('_Aucun._');
  });

  it('handles an empty run without producing broken tables', () => {
    const markdown = buildReport(
      input({ artifacts: [], problems: [], pageCounts: {}, frontierCounts: {} }),
    ).markdown;
    expect(markdown).toContain('_Aucun artifact produit._');
    expect(markdown).toContain('_Aucune page enregistrée._');
    expect(markdown).toContain('_Frontier vide._');
  });

  it('reports a fatal error in full', () => {
    const failed: Run = { ...RUN, status: 'failed', stopReason: 'error', error: 'boom' };
    const markdown = buildReport(input({ run: failed })).markdown;
    expect(markdown).toContain('## Erreur fatale');
    expect(markdown).toContain('boom');
    expect(markdown).toContain('`failed`');
  });

  it('formats durations and sizes readably', () => {
    const markdown = buildReport(input()).markdown;
    expect(markdown).toContain('2m 30s');
    expect(markdown).toContain('2.0 MB');
  });

  it('marks an unfinished run as in progress rather than guessing', () => {
    const running: Run = { ...RUN, status: 'running', finishedAt: null, stopReason: null };
    expect(buildReport(input({ run: running })).markdown).toContain('in progress');
  });

  it('includes the workflow return value verbatim', () => {
    const json = JSON.parse(
      buildReport(input({ result: { collected: 4, remaining: 0 } })).json,
    ) as { result: unknown };
    expect(json.result).toEqual({ collected: 4, remaining: 0 });
  });

  it('ends with exactly one trailing newline in both forms', () => {
    const report = buildReport(input());
    expect(report.markdown.endsWith('\n')).toBe(true);
    expect(report.markdown.endsWith('\n\n')).toBe(false);
    expect(report.json.endsWith('\n')).toBe(true);
  });
});
