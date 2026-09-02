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
 * A page that has already been worked is *requeued*, not enqueued: `enqueue` refuses
 * to resurrect a `done` entry — that refusal is what stops a crawl looping over a
 * page linked from every other page — while a revisit is the opposite intention,
 * because time has passed. Going through `enqueue` here silently did nothing for
 * every page that had ever been collected, which is to say for every page a veille
 * workflow cares about.
 *
 * Safe to call at the start of every run: a page still queued or leased is left
 * alone, and only pages whose due date has actually arrived move.
 *
 * @returns how many pages were newly queued.
 */
export function enqueueDueRevisits(store: Store, options: RevisitOptions): number {
  const at = options.at ?? nowIso();
  const due = store.pages.dueForRevisit(options.jobId, at, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.includeGone === undefined ? {} : { includeGone: options.includeGone }),
  });

  const priority = options.priority ?? 120;
  let queued = 0;

  for (const page of due) {
    // Already worked: bring it back. Never seen by the frontier: add it.
    const requeued = store.frontier.requeue(options.jobId, page.canonicalUrl, priority);
    const added =
      requeued ||
      store.frontier.enqueue({
        jobId: options.jobId,
        url: page.url,
        canonicalUrl: page.canonicalUrl,
        priority,
      });
    if (added) queued += 1;
  }
  return queued;
}
