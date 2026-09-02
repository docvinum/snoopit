/**
 * Bringing known pages back into the queue.
 *
 * A crawl is not only about discovering new URLs: a monitoring job exists to notice
 * that a page it already knows has *changed*. `next_visit_after` is when a page
 * becomes worth looking at again, and this is what turns that date into work.
 */

import type { Store } from '../state/store.js';
import { nowIso } from '../util/time.js';

export interface RevisitOptions {
  readonly jobId: string;
  readonly at?: string;
  readonly limit?: number;
  /**
   * Also re-queue pages marked `gone`, to notice a resource reappearing — a delisted
   * classified ad that comes back (docs/USE_CASES.md §3). Off by default: a 404 is
   * usually final.
   */
  readonly includeGone?: boolean;
  /** Priority for re-queued pages. Lower runs sooner; defaults below new discoveries. */
  readonly priority?: number;
}

/**
 * Re-queues pages whose revisit time has come.
 *
 * Idempotent through the frontier: a page already queued or leased is not queued
 * twice, so calling this at the start of every run is safe.
 *
 * @returns how many pages were newly queued.
 */
export function enqueueDueRevisits(store: Store, options: RevisitOptions): number {
  const at = options.at ?? nowIso();
  const due = store.pages.dueForRevisit(options.jobId, at, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.includeGone === undefined ? {} : { includeGone: options.includeGone }),
  });

  let queued = 0;
  for (const page of due) {
    const added = store.frontier.enqueue({
      jobId: options.jobId,
      url: page.url,
      canonicalUrl: page.canonicalUrl,
      priority: options.priority ?? 120,
    });
    if (added) queued += 1;
  }
  return queued;
}
