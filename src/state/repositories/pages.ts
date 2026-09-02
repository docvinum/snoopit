import type { Db } from '../db.js';
import { orNull } from '../row.js';
import type { Page, PageStatus } from '../types.js';
import { nowIso } from '../../util/time.js';

interface PageRow {
  id: number;
  job_id: string;
  url: string;
  canonical_url: string;
  first_seen_at: string;
  last_seen_at: string;
  last_visited_at: string | null;
  last_changed_at: string | null;
  content_hash: string | null;
  status: PageStatus;
  http_status: number | null;
  title: string | null;
  visit_count: number;
  error_count: number;
  last_error: string | null;
  next_visit_after: string | null;
}

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    jobId: row.job_id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastVisitedAt: row.last_visited_at,
    lastChangedAt: row.last_changed_at,
    contentHash: row.content_hash,
    status: row.status,
    httpStatus: row.http_status,
    title: row.title,
    visitCount: row.visit_count,
    errorCount: row.error_count,
    lastError: row.last_error,
    nextVisitAfter: row.next_visit_after,
  };
}

export interface DiscoverPageInput {
  readonly jobId: string;
  readonly url: string;
  readonly canonicalUrl: string;
}

export interface RecordVisitInput {
  readonly jobId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly contentHash?: string | null;
  readonly httpStatus?: number | null;
  readonly title?: string | null;
  readonly nextVisitAfter?: string | null;
}

export interface RecordVisitResult {
  readonly page: Page;
  /** True when the content hash differs from the previous visit. Drives CONTENT_CHANGED. */
  readonly changed: boolean;
  /** True when this URL had never been visited before. */
  readonly firstVisit: boolean;
}

export class PageRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records that a URL exists, without visiting it.
   *
   * Idempotent by `(job_id, canonical_url)`: re-discovering a known URL only
   * refreshes `last_seen_at`, so `first_seen_at` keeps its original meaning across
   * every run. That pairing is what the provenance requirement (spec §3) needs.
   */
  discover(input: DiscoverPageInput): Page {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO crawl_pages (job_id, url, canonical_url, first_seen_at, last_seen_at, status)
         VALUES (?, ?, ?, ?, ?, 'discovered')
         ON CONFLICT(job_id, canonical_url) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(input.jobId, input.url, input.canonicalUrl, at, at);
    return this.get(input.jobId, input.canonicalUrl)!;
  }

  /**
   * Records a successful visit and reports whether the content changed.
   *
   * A successful visit clears the error streak: `error_count` returns to 0 and
   * `last_error` is dropped. Errors are interesting as a *current* condition —
   * a page that failed twice last week and works today is simply working.
   */
  recordVisit(input: RecordVisitInput): RecordVisitResult {
    const at = nowIso();
    const existing = this.get(input.jobId, input.canonicalUrl);
    const newHash = orNull(input.contentHash);

    const firstVisit = existing === null || existing.lastVisitedAt === null;
    const changed =
      !firstVisit &&
      existing !== null &&
      existing.contentHash !== null &&
      newHash !== null &&
      existing.contentHash !== newHash;

    const status: PageStatus = changed ? 'changed' : 'visited';
    const lastChangedAt = changed ? at : (existing?.lastChangedAt ?? null);

    this.db
      .prepare(
        `INSERT INTO crawl_pages (job_id, url, canonical_url, first_seen_at, last_seen_at,
                                  last_visited_at, last_changed_at, content_hash, status,
                                  http_status, title, visit_count, error_count, last_error,
                                  next_visit_after)
         VALUES (@jobId, @url, @canonicalUrl, @at, @at, @at, @lastChangedAt, @hash, @status,
                 @httpStatus, @title, 1, 0, NULL, @nextVisitAfter)
         ON CONFLICT(job_id, canonical_url) DO UPDATE SET
           url = excluded.url,
           last_seen_at = excluded.last_seen_at,
           last_visited_at = excluded.last_visited_at,
           last_changed_at = excluded.last_changed_at,
           content_hash = COALESCE(excluded.content_hash, crawl_pages.content_hash),
           status = excluded.status,
           http_status = excluded.http_status,
           title = COALESCE(excluded.title, crawl_pages.title),
           visit_count = crawl_pages.visit_count + 1,
           error_count = 0,
           last_error = NULL,
           next_visit_after = excluded.next_visit_after`,
      )
      .run({
        jobId: input.jobId,
        url: input.url,
        canonicalUrl: input.canonicalUrl,
        at,
        lastChangedAt,
        hash: newHash,
        status,
        httpStatus: orNull(input.httpStatus),
        title: orNull(input.title),
        nextVisitAfter: orNull(input.nextVisitAfter),
      });

    return { page: this.get(input.jobId, input.canonicalUrl)!, changed, firstVisit };
  }

  /** Records a failed visit, incrementing the error streak. */
  recordError(input: {
    readonly jobId: string;
    readonly url: string;
    readonly canonicalUrl: string;
    readonly error: string;
    readonly httpStatus?: number | null;
  }): Page {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO crawl_pages (job_id, url, canonical_url, first_seen_at, last_seen_at,
                                  status, http_status, error_count, last_error)
         VALUES (@jobId, @url, @canonicalUrl, @at, @at, 'error', @httpStatus, 1, @error)
         ON CONFLICT(job_id, canonical_url) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           status = 'error',
           http_status = excluded.http_status,
           error_count = crawl_pages.error_count + 1,
           last_error = excluded.last_error`,
      )
      .run({
        jobId: input.jobId,
        url: input.url,
        canonicalUrl: input.canonicalUrl,
        at,
        httpStatus: orNull(input.httpStatus),
        error: input.error,
      });
    return this.get(input.jobId, input.canonicalUrl)!;
  }

  /** Marks a page as no longer reachable (404/410 on a URL we used to know). */
  markGone(jobId: string, canonicalUrl: string, httpStatus?: number | null): Page | null {
    this.db
      .prepare(
        `UPDATE crawl_pages
            SET status = 'gone', last_seen_at = ?, http_status = COALESCE(?, http_status)
          WHERE job_id = ? AND canonical_url = ?`,
      )
      .run(nowIso(), orNull(httpStatus), jobId, canonicalUrl);
    return this.get(jobId, canonicalUrl);
  }

  get(jobId: string, canonicalUrl: string): Page | null {
    const row = this.db
      .prepare('SELECT * FROM crawl_pages WHERE job_id = ? AND canonical_url = ?')
      .get(jobId, canonicalUrl) as PageRow | undefined;
    return row === undefined ? null : toPage(row);
  }

  listByStatus(jobId: string, status: PageStatus, limit = 100): Page[] {
    return (
      this.db
        .prepare('SELECT * FROM crawl_pages WHERE job_id = ? AND status = ? ORDER BY id LIMIT ?')
        .all(jobId, status, limit) as PageRow[]
    ).map(toPage);
  }

  /**
   * Pages whose `next_visit_after` has come due. Drives scheduled revisits.
   *
   * `gone` pages are excluded by default — a 404 is usually final. They can be
   * included on demand, because some jobs need to notice a resource *reappearing*
   * (a delisted classified ad that comes back). Which of the two a job wants is a
   * scheduling policy, decided in Lot 4, not something to hard-code here.
   */
  dueForRevisit(
    jobId: string,
    at: string = nowIso(),
    options: { readonly limit?: number; readonly includeGone?: boolean } = {},
  ): Page[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM crawl_pages
            WHERE job_id = ?
              AND next_visit_after IS NOT NULL
              AND next_visit_after <= ?
              AND (? = 1 OR status != 'gone')
            ORDER BY next_visit_after
            LIMIT ?`,
        )
        .all(jobId, at, options.includeGone === true ? 1 : 0, options.limit ?? 100) as PageRow[]
    ).map(toPage);
  }

  countByStatus(jobId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM crawl_pages WHERE job_id = ? GROUP BY status')
      .all(jobId) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }
}
