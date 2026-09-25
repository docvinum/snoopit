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
import type {
  Artifact,
  FrontierEntry,
  Item,
  ItemChange,
  ItemDiff,
  ItemFields,
  ItemStatus,
  Job,
  ObservationStatus,
  Page,
  Run,
  RunBudget,
} from '../../state/types.js';
import type { NavigationResult } from '../browser/types.js';
import type { RunEventEmitter } from '../events/emitter.js';
import type { BudgetGuard } from '../budget/guard.js';
import type { RecoverOptions, RecoveryOutcome } from '../recovery/recover.js';
import type { DismissResult } from '../recovery/heuristics.js';
import type { SessionExpectation } from '../navigation/session.js';

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
  /**
   * Declares this page as one that needs a logged-in session, and what a logged-in
   * visit looks like. Landing on a login wall instead stops the run with
   * `auth-required` — before the login page is recorded as this URL's content.
   *
   * ```ts
   * await ctx.visit('https://www.leboncoin.fr/my-searches', {
   *   session: { expectHost: 'www.leboncoin.fr' },
   * });
   * ```
   */
  readonly session?: SessionExpectation;
}

export interface VisitResult {
  readonly page: PageHandle;
  readonly navigation: NavigationResult;
  /** The stored page row, or `null` when `record` was false. */
  readonly record: Page | null;
  /** True when the content hash differs from the previous visit. */
  readonly changed: boolean;
  readonly firstVisit: boolean;
  /**
   * True when the navigation ended on another site (`www.` aside). Recorded as an
   * error against the page, not as a visit: what answered there is not this URL's
   * content.
   */
  readonly offSite: boolean;
}

export interface RevisitOption {
  /** When the entry is worth working again, as a duration (`20h`, `7d`). */
  readonly revisitAfter?: string;
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
  /**
   * Record nothing new when the job already holds these exact bytes, at this URL or
   * another. The file is still fetched — its hash is only known once it has
   * arrived — and counts against the budget, but nothing is written. Default: true.
   */
  readonly dedupe?: boolean;
  readonly timeoutMs?: number;
}

export interface CollectResult {
  readonly artifact: Artifact;
  /**
   * True when the job already held these exact bytes: `artifact` is that earlier
   * record and nothing was written. The transfer itself still happened.
   */
  readonly deduplicated: boolean;
}

export interface ItemObservation {
  /** `new`, `changed`, `returned` (was gone, is back) or `unchanged`. */
  readonly status: ObservationStatus;
  readonly item: Item;
  /** Field-level changes since the previous observation, e.g. `{ prix: { from: 250, to: 220 } }`. */
  readonly diff: ItemDiff;
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
    /**
     * Marks an entry done. With `revisitAfter` (`20h`, `7d`), the entry comes back
     * through `enqueueDueRevisits()` once that time has passed — what `visit`'s own
     * `revisitAfter` does for pages it loads, for work reached any other way (a
     * click, a download).
     */
    complete(entry: FrontierEntry, options?: RevisitOption): void;
    /** Marks an entry failed. With `revisitAfter`, it is retried after that delay. */
    fail(entry: FrontierEntry, error: string, options?: RevisitOption): void;
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

  /**
   * Things followed by the site's own identifier — an ad, a product — across runs.
   *
   * Pages are identified by URL and compared as a whole; items are identified by a
   * key the site gives them and compared field by field. That is what "is this ad
   * new, did its price drop, has it disappeared?" needs, with the answer and its
   * history kept in SQLite rather than in last run's JSON.
   */
  readonly items: {
    /**
     * Records that `key` was seen now with these fields, and says what changed.
     * Emits `ITEM_NEW`, `ITEM_CHANGED` or `ITEM_RETURNED` accordingly.
     */
    observe(kind: string, key: string, fields: ItemFields): ItemObservation;
    /**
     * Marks as gone every present item of `kind` this run did not observe, emitting
     * `ITEM_GONE` for each. Call it only after observing the *complete* set — a
     * first page of results is not the whole list. Scope `kind` to match, e.g.
     * `annonce:<search>`.
     */
    markMissing(kind: string): Item[];
    get(kind: string, key: string): Item | null;
    list(kind?: string, options?: { status?: ItemStatus }): Item[];
    /** Every appearance, change, disappearance and return of an item, oldest first. */
    history(kind: string, key: string): ItemChange[];
  };

  /** Extracts structured records from a page. Sugar over `page.extractAll`. */
  extract<F extends FieldMap>(
    page: PageHandle,
    spec: ExtractSpec<F>,
  ): Promise<ExtractedRecord<F>[]>;

  /**
   * Dismisses recognised overlays deterministically.
   *
   * Cheap and safe to call before any interaction — the `beforeAction` pattern of
   * spec §14.
   */
  dismissOverlays(page: PageHandle): Promise<DismissResult>;

  /**
   * Gets the page back to an expected state, escalating L1 -> L2 -> L3 -> L4.
   *
   * Returns immediately when the state is already there, so guarding an action with
   * it costs nothing on the nominal path. Throws `RecoveryFailedError` when every
   * level is exhausted, and `BlockedError` when the site is refusing us.
   */
  recover(page: PageHandle, options: RecoverOptions): Promise<RecoveryOutcome>;
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
