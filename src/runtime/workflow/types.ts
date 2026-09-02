/**
 * The workflow API.
 *
 * A workflow declares *what* to visit and *what* to keep. The runtime owns budgets,
 * persistence, provenance and events. Nothing a workflow can write should be able to
 * corrupt crawl state or reach the database, the CDP connection or the proxy — which
 * is why the context below exposes intentions (`visit`, `discover`, `collect`) rather
 * than the repositories and the backend themselves.
 *
 * This shape is deliberately not frozen (spec §4). It will grow with Lots 4 and 5.
 */

import type { BrowserBackend, PageHandle } from '../browser/types.js';
import type { ExtractedRecord, ExtractSpec, FieldMap } from '../extraction/spec.js';
import type { Artifact, FrontierEntry, Job, Page, Run, RunBudget } from '../../state/types.js';
import type { NavigationResult } from '../browser/types.js';
import type { RunEventEmitter } from '../events/emitter.js';
import type { BudgetGuard } from '../budget/guard.js';

export interface VisitOptions {
  readonly waitFor?: string;
  readonly timeoutMs?: number;
  /** Record the visit in `crawl_pages`. Default: true. */
  readonly record?: boolean;
  /**
   * When this page becomes worth looking at again, as a duration (`7d`, `12h`).
   * Stored as `next_visit_after`; `frontier.enqueueDueRevisits()` turns it into work.
   */
  readonly revisitAfter?: string;
}

export interface VisitResult {
  readonly page: PageHandle;
  readonly navigation: NavigationResult;
  /** The stored page row, or `null` when `record` was false. */
  readonly record: Page | null;
  /** True when the content hash differs from the previous visit. */
  readonly changed: boolean;
  readonly firstVisit: boolean;
}

export interface DiscoverOptions {
  readonly kind?: FrontierEntry['kind'];
  /** Lower runs sooner. Defaults to 100. */
  readonly priority?: number;
  readonly depth?: number;
  readonly meta?: Record<string, unknown>;
}

export interface CollectOptions {
  /** Sub-directory under the job's artifacts, e.g. `publications`. */
  readonly dir?: string;
  readonly filename?: string;
  /** Skip the download when a byte-identical artifact already exists. Default: true. */
  readonly dedupe?: boolean;
  readonly timeoutMs?: number;
}

export interface CollectResult {
  readonly artifact: Artifact;
  /** True when an identical artifact already existed and nothing was downloaded. */
  readonly deduplicated: boolean;
}

/** What a workflow is handed. The only surface it is allowed to use. */
export interface WorkflowContext {
  readonly job: Job;
  readonly run: Run;
  readonly browser: BrowserBackend;
  readonly events: RunEventEmitter;
  /** The run's budget. Enforced automatically; readable for a workflow's own pacing. */
  readonly budget: BudgetGuard;

  /**
   * Opens a URL, records the visit and emits the matching events.
   *
   * The caller still owns the returned page and must close it. Everything about
   * memory — first seen, last visited, content hash, change detection — happens
   * here so a workflow cannot forget to do it.
   */
  visit(url: string, options?: VisitOptions): Promise<VisitResult>;

  readonly frontier: {
    /** Records a URL as worth visiting. Idempotent. Returns true when new. */
    discover(url: string, options?: DiscoverOptions): boolean;
    /** Records many at once, returning how many were new. */
    discoverAll(urls: readonly string[], options?: DiscoverOptions): number;
    /** Claims the next batch of work for this run. */
    take(limit: number): FrontierEntry[];
    complete(entry: FrontierEntry): void;
    fail(entry: FrontierEntry, error: string): void;
    remaining(): number;
    /**
     * Re-queues known pages whose `revisitAfter` has come due.
     * Idempotent, so calling it at the start of a run is safe.
     */
    enqueueDueRevisits(options?: { limit?: number; includeGone?: boolean }): number;
  };

  readonly artifacts: {
    /** Downloads a URL through the page's session and records its provenance. */
    collect(page: PageHandle, url: string, options?: CollectOptions): Promise<CollectResult>;
    writeJson(name: string, data: unknown, options?: { dir?: string }): Promise<Artifact>;
    writeMarkdown(name: string, text: string, options?: { dir?: string }): Promise<Artifact>;
    screenshot(page: PageHandle, name: string): Promise<Artifact>;
  };

  /** Extracts structured records from a page. Sugar over `page.extractAll`. */
  extract<F extends FieldMap>(
    page: PageHandle,
    spec: ExtractSpec<F>,
  ): Promise<ExtractedRecord<F>[]>;
}

export interface WorkflowDefinition<T = unknown> {
  readonly name: string;
  /** `audit` produces a report; `collect` gathers content. Free-form beyond that. */
  readonly type?: 'audit' | 'collect';
  readonly description?: string;
  readonly budget?: RunBudget;
  readonly browserProfile?: string;
  readonly networkProfile?: string;
  /** The workflow body. Its return value is stored in the run report. */
  run(ctx: WorkflowContext): Promise<T>;
}

/**
 * Declares a workflow.
 *
 * Currently an identity function with a type annotation, and that is the point: the
 * value of `workflow()` is that a workflow file is a plain, statically-checked
 * module a coding agent can generate and a reviewer can read — not a registration
 * side effect in a hidden registry.
 */
export function workflow<T>(definition: WorkflowDefinition<T>): WorkflowDefinition<T> {
  if (definition.name.trim() === '') {
    throw new Error('workflow(): name is required');
  }
  return definition;
}
