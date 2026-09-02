/**
 * The documentation must describe the code that exists.
 *
 * `skills/snoopit/SKILL.md` is the only thing a coding agent reads before writing a
 * workflow. If it names a primitive that has been renamed or removed, the agent
 * writes code that cannot compile — and the failure looks like the agent being wrong
 * rather than the documentation being stale.
 *
 * So the skill is parsed, every `ctx.…` and `page.…` call it shows is extracted, and
 * each one is checked against a real context and a real page. Documentation drift
 * becomes a failing test rather than a bad first experience.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { RunEventEmitter } from '../../src/runtime/events/emitter.js';
import { BudgetGuard } from '../../src/runtime/budget/guard.js';
import { RunContext } from '../../src/runtime/workflow/context.js';
import { Store } from '../../src/state/store.js';
import { buildFakeSite } from '../support/fake-site.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SKILL = readFileSync(join(REPO_ROOT, 'skills/snoopit/SKILL.md'), 'utf8');
const GUIDE = readFileSync(join(REPO_ROOT, 'docs/WORKFLOWS.md'), 'utf8');

/** Extracts `root.a.b` call paths from documented code, e.g. `ctx.frontier.discover`. */
function documentedCalls(markdown: string, root: string): string[] {
  const pattern = new RegExp(`\\b${root}((?:\\.[a-zA-Z]\\w*)+)\\s*\\(`, 'g');
  const found = new Set<string>();
  for (const match of markdown.matchAll(pattern)) {
    found.add(match[1]!.slice(1));
  }
  return [...found].sort();
}

/** Walks a dotted path, returning whether it resolves to a function. */
function resolvesToFunction(target: unknown, path: string): boolean {
  const value = path.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    return (current as Record<string, unknown>)[key];
  }, target);
  return typeof value === 'function';
}

function buildContext(): { ctx: RunContext; store: Store } {
  const dataDir = mkdtempSync(join(tmpdir(), 'snoopit-docs-'));
  const store = Store.open({ path: join(dataDir, 'snoopit.db') });
  const job = store.jobs.upsert({ name: 'docs-job', workflow: 'docs' });
  const run = store.runs.start({ jobId: job.id, trigger: 'manual' });

  const ctx = new RunContext({
    store,
    job,
    run,
    browser: new FakeBackend(buildFakeSite()),
    events: new RunEventEmitter({ store, jobId: job.id, runId: run.id, onLine: () => undefined }),
    dataDir,
    budget: new BudgetGuard(null),
  });
  return { ctx, store };
}

describe('the skill describes primitives that exist', () => {
  it('names at least a representative set of them', () => {
    // Guards against the extraction silently matching nothing and passing vacuously.
    const calls = documentedCalls(SKILL, 'ctx');
    expect(calls.length).toBeGreaterThan(8);
    expect(calls).toContain('visit');
    expect(calls).toContain('frontier.discover');
    expect(calls).toContain('artifacts.collect');
  });

  it('every ctx.… call shown in the skill exists', () => {
    const { ctx, store } = buildContext();
    try {
      const missing = documentedCalls(SKILL, 'ctx').filter(
        (path) => !resolvesToFunction(ctx, path),
      );
      expect(
        missing,
        `Documented in SKILL.md but absent from WorkflowContext: ${missing.join(', ')}`,
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('every ctx.… call shown in the workflow guide exists', () => {
    const { ctx, store } = buildContext();
    try {
      const missing = documentedCalls(GUIDE, 'ctx').filter(
        (path) => !resolvesToFunction(ctx, path),
      );
      expect(missing, `Documented in WORKFLOWS.md but absent: ${missing.join(', ')}`).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('every page.… call shown in the docs exists', async () => {
    const backend = new FakeBackend(buildFakeSite());
    const page = await backend.newPage();
    try {
      const documented = [
        ...new Set([...documentedCalls(SKILL, 'page'), ...documentedCalls(GUIDE, 'page')]),
      ];
      const missing = documented.filter((path) => !resolvesToFunction(page, path));
      expect(missing, `Documented but absent from PageHandle: ${missing.join(', ')}`).toEqual([]);
    } finally {
      await page.close();
      await backend.close();
    }
  });
});

describe('the skill points at code that exists', () => {
  it('references only example workflows that are present', () => {
    const referenced = [...SKILL.matchAll(/`?(example-[a-z-]+)\.ts`?/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);

    for (const name of new Set(referenced)) {
      expect(
        readFileSync(join(REPO_ROOT, 'workflows', `${name}.ts`), 'utf8').length,
        `SKILL.md references workflows/${name}.ts`,
      ).toBeGreaterThan(0);
    }
  });

  it('references only test files that are present', () => {
    const referenced = [...SKILL.matchAll(/`?(tests\/[\w/-]+\.test\.ts)`?/g)].map((m) => m[1]!);
    for (const path of new Set(referenced)) {
      expect(readFileSync(join(REPO_ROOT, path), 'utf8').length).toBeGreaterThan(0);
    }
  });
});
