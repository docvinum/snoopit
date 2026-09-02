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
 * Enqueueing is the deduplication-critical half; leasing is what lets a run claim
 * work without two runs doing it twice. Reclaiming a *stale* lease left by a crashed
 * run, and limiting how much is taken per run, are scheduling policy and belong to
 * Lot 4 — this repository only provides the mechanism.
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

  /**
   * Claims up to `limit` queued entries for a run.
   *
   * Claiming and reading happen in one transaction: two runs racing for the same
   * entry cannot both win, because the second one no longer sees it as `queued`.
   * The lease carries an expiry so a crashed run's work becomes reclaimable — Lot 4
   * decides when to reclaim it.
   */
  lease(input: {
    readonly jobId: string;
    readonly runId: string;
    readonly limit: number;
    readonly leaseExpiresAt: string;
    readonly at?: string;
  }): FrontierEntry[] {
    const at = input.at ?? nowIso();

    return this.db.transaction((): FrontierEntry[] => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM crawl_frontier
            WHERE job_id = ?
              AND state = 'queued'
              AND (available_after IS NULL OR available_after <= ?)
            ORDER BY priority ASC, depth ASC, id ASC
            LIMIT ?`,
        )
        .all(input.jobId, at, input.limit) as { id: number }[];

      if (candidates.length === 0) return [];

      const claim = this.db.prepare(
        `UPDATE crawl_frontier
            SET state = 'leased', lease_run_id = ?, lease_expires_at = ?,
                attempts = attempts + 1, updated_at = ?
          WHERE id = ?`,
      );
      for (const candidate of candidates) {
        claim.run(input.runId, input.leaseExpiresAt, at, candidate.id);
      }

      const placeholders = candidates.map(() => '?').join(',');
      return (
        this.db
          .prepare(
            `SELECT * FROM crawl_frontier WHERE id IN (${placeholders})
              ORDER BY priority ASC, depth ASC, id ASC`,
          )
          .all(...candidates.map((c) => c.id)) as FrontierRow[]
      ).map(toEntry);
    })();
  }

  /** Marks a leased entry finished. Its lease is released. */
  complete(jobId: string, canonicalUrl: string): void {
    this.releaseWithState(jobId, canonicalUrl, 'done', null);
  }

  /** Marks a leased entry failed, keeping the error for the run report. */
  fail(jobId: string, canonicalUrl: string, error: string): void {
    this.releaseWithState(jobId, canonicalUrl, 'failed', error);
  }

  /** Returns an entry to the queue, e.g. when a run stops before working it. */
  release(jobId: string, canonicalUrl: string): void {
    this.releaseWithState(jobId, canonicalUrl, 'queued', null);
  }

  /**
   * Brings a finished entry back into the queue.
   *
   * Distinct from `enqueue`, which deliberately refuses to resurrect a `done` entry —
   * that refusal is what stops a crawl looping over a page linked from everywhere.
   * A revisit is the opposite intention: the work *should* happen again because time
   * has passed. Conflating the two silently disables revisits altogether.
   *
   * A `leased` entry is never touched: a live run is holding it.
   *
   * @returns true when an entry was actually requeued.
   */
  requeue(jobId: string, canonicalUrl: string, priority?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE crawl_frontier
            SET state = 'queued',
                priority = COALESCE(?, priority),
                lease_run_id = NULL,
                lease_expires_at = NULL,
                available_after = NULL,
                updated_at = ?
          WHERE job_id = ? AND canonical_url = ?
            AND state IN ('done', 'failed', 'skipped')`,
      )
      .run(priority ?? null, nowIso(), jobId, canonicalUrl);
    return result.changes > 0;
  }

  private releaseWithState(
    jobId: string,
    canonicalUrl: string,
    state: FrontierState,
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE crawl_frontier
            SET state = ?, last_error = COALESCE(?, last_error),
                lease_run_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ? AND canonical_url = ?`,
      )
      .run(state, error, nowIso(), jobId, canonicalUrl);
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

  /**
   * Returns abandoned leases to the queue.
   *
   * A lease is abandoned when the run holding it is no longer `running` — that is
   * the real signal, and it is immediate. The expiry timestamp is only a backstop
   * for the case where a run row somehow never gets closed.
   *
   * Waiting for the timer instead would strand a killed run's work for the whole
   * lease duration, which is exactly the stall this exists to prevent. A *live*
   * run's lease is never touched, which is what keeps this safe to call at the
   * start of every run.
   *
   * @returns how many entries were reclaimed.
   */
  reclaimAbandonedLeases(jobId: string, at: string = nowIso()): number {
    const result = this.db
      .prepare(
        `UPDATE crawl_frontier
            SET state = 'queued', lease_run_id = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
            AND state = 'leased'
            AND (
              lease_run_id IS NULL
              OR lease_run_id NOT IN (SELECT id FROM runs WHERE status = 'running')
              OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            )`,
      )
      .run(at, jobId, at);
    return result.changes;
  }

  /** Entries currently leased by a run, whatever their expiry. */
  leasedBy(runId: string): FrontierEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM crawl_frontier WHERE lease_run_id = ? AND state = 'leased' ORDER BY id",
        )
        .all(runId) as FrontierRow[]
    ).map(toEntry);
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
