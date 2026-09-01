import type { Db } from '../db.js';
import { fromJson, orNull, toJson } from '../row.js';
import type { FrontierEntry, FrontierKind, FrontierState } from '../types.js';
import { nowIso } from '../../util/time.js';

interface FrontierRow {
  id: number;
  job_id: string;
  url: string;
  canonical_url: string;
  kind: FrontierKind;
  state: FrontierState;
  priority: number;
  depth: number;
  attempts: number;
  available_after: string | null;
  lease_run_id: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  meta_json: string | null;
  discovered_at: string;
  updated_at: string;
}

function toEntry(row: FrontierRow): FrontierEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    depth: row.depth,
    attempts: row.attempts,
    availableAfter: row.available_after,
    leaseRunId: row.lease_run_id,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    meta: fromJson<Record<string, unknown>>(row.meta_json),
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueInput {
  readonly jobId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly kind?: FrontierKind;
  readonly priority?: number;
  readonly depth?: number;
  readonly availableAfter?: string | null;
  readonly meta?: Record<string, unknown> | null;
}

/**
 * The work queue: what is left to do for a job.
 *
 * Lot 1 implements enqueueing — the deduplication-critical half. Leasing, retry
 * and priority draining land in Lot 4, where they are tested against the
 * kill-and-resume acceptance case.
 */
export class FrontierRepository {
  constructor(private readonly db: Db) {}

  /**
   * Adds a URL to the queue if it is not already known.
   *
   * Idempotent by `(job_id, canonical_url)`. Re-discovering an entry never resets
   * its state: a URL already `done` this run stays `done`, which is precisely what
   * stops a crawl from looping over a page linked from every other page. A repeat
   * discovery may only *raise* priority (lower number), never lower it.
   *
   * @returns true when a new entry was created.
   */
  enqueue(input: EnqueueInput): boolean {
    const at = nowIso();
    const params = {
      jobId: input.jobId,
      url: input.url,
      canonicalUrl: input.canonicalUrl,
      kind: input.kind ?? 'page',
      priority: input.priority ?? 100,
      depth: input.depth ?? 0,
      availableAfter: orNull(input.availableAfter),
      meta: toJson(orNull(input.meta)),
      at,
    };

    return this.db.transaction((): boolean => {
      const existing = this.db
        .prepare('SELECT id FROM crawl_frontier WHERE job_id = ? AND canonical_url = ?')
        .get(input.jobId, input.canonicalUrl) as { id: number } | undefined;

      if (existing !== undefined) {
        this.db
          .prepare(
            `UPDATE crawl_frontier
                SET priority = MIN(priority, @priority), updated_at = @at
              WHERE id = @id`,
          )
          .run({ priority: params.priority, at, id: existing.id });
        return false;
      }

      this.db
        .prepare(
          `INSERT INTO crawl_frontier (job_id, url, canonical_url, kind, state, priority, depth,
                                       available_after, meta_json, discovered_at, updated_at)
           VALUES (@jobId, @url, @canonicalUrl, @kind, 'queued', @priority, @depth,
                   @availableAfter, @meta, @at, @at)`,
        )
        .run(params);
      return true;
    })();
  }

  get(jobId: string, canonicalUrl: string): FrontierEntry | null {
    const row = this.db
      .prepare('SELECT * FROM crawl_frontier WHERE job_id = ? AND canonical_url = ?')
      .get(jobId, canonicalUrl) as FrontierRow | undefined;
    return row === undefined ? null : toEntry(row);
  }

  /** Queued entries in the order they would be worked, without leasing them. */
  peek(jobId: string, limit = 10, at: string = nowIso()): FrontierEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM crawl_frontier
            WHERE job_id = ?
              AND state = 'queued'
              AND (available_after IS NULL OR available_after <= ?)
            ORDER BY priority ASC, depth ASC, id ASC
            LIMIT ?`,
        )
        .all(jobId, at, limit) as FrontierRow[]
    ).map(toEntry);
  }

  setState(jobId: string, canonicalUrl: string, state: FrontierState, lastError?: string): void {
    this.db
      .prepare(
        `UPDATE crawl_frontier
            SET state = ?, last_error = COALESCE(?, last_error), updated_at = ?
          WHERE job_id = ? AND canonical_url = ?`,
      )
      .run(state, orNull(lastError), nowIso(), jobId, canonicalUrl);
  }

  countByState(jobId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM crawl_frontier WHERE job_id = ? GROUP BY state')
      .all(jobId) as { state: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  }

  /** Number of entries still to be worked. Zero means the crawl is exhausted. */
  remaining(jobId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM crawl_frontier
          WHERE job_id = ? AND state IN ('queued','leased')`,
      )
      .get(jobId) as { n: number };
    return row.n;
  }
}
