/**
 * Run budgets.
 *
 * A budget is what turns "crawl this site" into a bounded, predictable amount of
 * work. Two properties matter:
 *
 *  - **Exhausting a budget is not a failure.** The run did what it was allowed to
 *    do; the rest waits for the next one. It therefore ends `completed` with a
 *    `stopReason` naming the limit, never `failed`.
 *  - **The limits in force are recorded in the report** (spec §10), so a truncated
 *    run explains itself rather than looking like a site that lost half its pages.
 *
 * The guard owns no clock of its own by default but accepts one, so duration limits
 * are testable without waiting.
 */

import { parseDuration } from '../../util/time.js';
import type { RunBudget } from '../../state/types.js';

/** Stable identifiers, used in `stopReason` and in the report. */
/** The kind of work being attempted. Each is bounded by its own limit. */
export type BudgetOperation = 'page' | 'download' | 'llm';

/**
 * `max_pages` bounds *units of crawl work*: an HTML page visit and a collected
 * document both count as one. Both are a network fetch and a unit of progress, and
 * counting only HTML visits would leave a `collect` workflow effectively unbounded.
 */
export type BudgetLimitName =
  'max_pages' | 'max_duration' | 'max_download_bytes' | 'max_llm_calls' | 'max_errors';

export interface BudgetUsage {
  readonly pages: number;
  readonly downloadedBytes: number;
  readonly llmCalls: number;
  readonly errors: number;
  readonly elapsedMs: number;
}

/**
 * A budget whose limits may be explicitly `undefined` — the shape the validated
 * config hands over. Unset and `undefined` mean the same thing: no limit here.
 */
export type LooseBudget = { readonly [K in keyof RunBudget]?: RunBudget[K] | undefined };

/**
 * The budget a run actually enforces: the specific one, over the defaults.
 *
 * Merged limit by limit, so a workflow declaring only `{ maxPages: 12 }` still gets
 * the configured duration and error limits. Replacing the defaults wholesale would
 * leave it unbounded on every limit it did not think to name — the failure the
 * defaults exist to prevent. A limit the workflow does name always wins.
 *
 * @returns `null` only when there is neither a specific budget nor a default one.
 */
export function effectiveBudget(
  specific: LooseBudget | null | undefined,
  defaults: LooseBudget | null | undefined,
): RunBudget | null {
  if ((specific ?? null) === null && (defaults ?? null) === null) return null;
  const merged: Record<string, unknown> = {};
  for (const source of [defaults, specific]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value !== undefined) merged[name] = value;
    }
  }
  return merged;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly limit: BudgetLimitName,
    readonly used: number,
    readonly max: number,
  ) {
    super(`Budget ${limit} reached: ${String(used)} of ${String(max)}`);
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetGuardOptions {
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class BudgetGuard {
  private pages = 0;
  private downloadedBytes = 0;
  private llmCalls = 0;
  private errors = 0;

  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly maxDurationMs: number | null;

  constructor(
    private readonly budget: RunBudget | null,
    options: BudgetGuardOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.maxDurationMs =
      budget?.maxDuration === undefined ? null : parseDuration(budget.maxDuration);
  }

  // ─── Consumption ───────────────────────────────────────────────────────────

  recordPage(count = 1): void {
    this.pages += count;
  }

  recordBytes(bytes: number): void {
    this.downloadedBytes += bytes;
  }

  recordLlmCall(count = 1): void {
    this.llmCalls += count;
  }

  recordError(count = 1): void {
    this.errors += count;
  }

  usage(): BudgetUsage {
    return {
      pages: this.pages,
      downloadedBytes: this.downloadedBytes,
      llmCalls: this.llmCalls,
      errors: this.errors,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  // ─── Checks ────────────────────────────────────────────────────────────────

  /**
   * The limit that forbids this operation, or `null`.
   *
   * Limits are *per operation*, not global: a page visit is bounded by `maxPages`,
   * a download by `maxDownloadBytes`, an LLM call by `maxLlmCalls`. Conflating them
   * makes `maxLlmCalls: 0` — the correct way to declare "this workflow uses no LLM"
   * — forbid the very first page visit, which is nonsense.
   *
   * Duration and errors are the exception: they bound the run as a whole and so
   * apply to every operation.
   *
   * Asked *before* acting, so `maxPages: 10` means ten pages are visited and the
   * eleventh is never started.
   */
  check(operation?: BudgetOperation): BudgetLimitName | null {
    const budget = this.budget;
    if (budget === null) return null;

    if (this.maxDurationMs !== null && this.now() - this.startedAt >= this.maxDurationMs) {
      return 'max_duration';
    }
    if (budget.maxErrors !== undefined && this.errors >= budget.maxErrors) return 'max_errors';

    switch (operation) {
      case 'page':
        return budget.maxPages !== undefined && this.pages >= budget.maxPages ? 'max_pages' : null;
      case 'download':
        return budget.maxDownloadBytes !== undefined &&
          this.downloadedBytes >= budget.maxDownloadBytes
          ? 'max_download_bytes'
          : null;
      case 'llm':
        return budget.maxLlmCalls !== undefined && this.llmCalls >= budget.maxLlmCalls
          ? 'max_llm_calls'
          : null;
      default:
        return null;
    }
  }

  /** True when no limit forbids this operation. */
  ok(operation?: BudgetOperation): boolean {
    return this.check(operation) === null;
  }

  /** Throws `BudgetExceededError` when a limit forbids this operation. */
  assertOk(operation?: BudgetOperation): void {
    const limit = this.check(operation);
    if (limit !== null) {
      throw new BudgetExceededError(limit, this.usedFor(limit), this.maxFor(limit));
    }
  }

  /**
   * How many more units of `limit` are allowed, or `null` when unlimited.
   * Used to size a frontier batch so a run never claims work it cannot do.
   */
  remaining(limit: BudgetLimitName): number | null {
    const max = this.maxFor(limit);
    if (!Number.isFinite(max)) return null;
    return Math.max(0, max - this.usedFor(limit));
  }

  private usedFor(limit: BudgetLimitName): number {
    switch (limit) {
      case 'max_pages':
        return this.pages;
      case 'max_duration':
        return this.now() - this.startedAt;
      case 'max_download_bytes':
        return this.downloadedBytes;
      case 'max_llm_calls':
        return this.llmCalls;
      case 'max_errors':
        return this.errors;
    }
  }

  private maxFor(limit: BudgetLimitName): number {
    const budget = this.budget;
    if (budget === null) return Number.POSITIVE_INFINITY;
    switch (limit) {
      case 'max_pages':
        return budget.maxPages ?? Number.POSITIVE_INFINITY;
      case 'max_duration':
        return this.maxDurationMs ?? Number.POSITIVE_INFINITY;
      case 'max_download_bytes':
        return budget.maxDownloadBytes ?? Number.POSITIVE_INFINITY;
      case 'max_llm_calls':
        return budget.maxLlmCalls ?? Number.POSITIVE_INFINITY;
      case 'max_errors':
        return budget.maxErrors ?? Number.POSITIVE_INFINITY;
    }
  }
}
