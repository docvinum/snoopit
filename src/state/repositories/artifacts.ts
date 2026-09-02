import type { Db } from '../db.js';
import { fromJson, orNull, toJson } from '../row.js';
import type { Artifact, ArtifactKind } from '../types.js';
import { nowIso } from '../../util/time.js';

interface ArtifactRow {
  id: number;
  job_id: string;
  run_id: string | null;
  page_id: number | null;
  source_url: string | null;
  canonical_url: string | null;
  kind: ArtifactKind;
  path: string;
  media_type: string | null;
  bytes: number | null;
  content_hash: string | null;
  created_at: string;
  meta_json: string | null;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    pageId: row.page_id,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    kind: row.kind,
    path: row.path,
    mediaType: row.media_type,
    bytes: row.bytes,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    meta: fromJson<Record<string, unknown>>(row.meta_json),
  };
}

export interface CreateArtifactInput {
  readonly jobId: string;
  readonly runId?: string | null;
  readonly pageId?: number | null;
  readonly sourceUrl?: string | null;
  readonly canonicalUrl?: string | null;
  readonly kind: ArtifactKind;
  /** Relative to the data directory. Storing absolute paths would break on a move. */
  readonly path: string;
  readonly mediaType?: string | null;
  readonly bytes?: number | null;
  readonly contentHash?: string | null;
  readonly meta?: Record<string, unknown> | null;
}

export class ArtifactRepository {
  constructor(private readonly db: Db) {}

  create(input: CreateArtifactInput): Artifact {
    const info = this.db
      .prepare(
        `INSERT INTO artifacts (job_id, run_id, page_id, source_url, canonical_url, kind, path,
                                media_type, bytes, content_hash, created_at, meta_json)
         VALUES (@jobId, @runId, @pageId, @sourceUrl, @canonicalUrl, @kind, @path,
                 @mediaType, @bytes, @contentHash, @at, @meta)`,
      )
      .run({
        jobId: input.jobId,
        runId: orNull(input.runId),
        pageId: orNull(input.pageId),
        sourceUrl: orNull(input.sourceUrl),
        canonicalUrl: orNull(input.canonicalUrl),
        kind: input.kind,
        path: input.path,
        mediaType: orNull(input.mediaType),
        bytes: orNull(input.bytes),
        contentHash: orNull(input.contentHash),
        at: nowIso(),
        meta: toJson(orNull(input.meta)),
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      ArtifactRow | undefined;
    return row === undefined ? null : toArtifact(row);
  }

  listByRun(runId: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY id')
        .all(runId) as ArtifactRow[]
    ).map(toArtifact);
  }

  listByJob(jobId: string, limit = 100): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(jobId, limit) as ArtifactRow[]
    ).map(toArtifact);
  }

  /**
   * Artifacts already stored for a job with this exact content.
   *
   * Content-addressed deduplication: a PDF republished at a second URL is the same
   * bytes, and re-downloading it wastes the run's byte budget for nothing.
   */
  findByHash(jobId: string, contentHash: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE job_id = ? AND content_hash = ? ORDER BY id')
        .all(jobId, contentHash) as ArtifactRow[]
    ).map(toArtifact);
  }

  totalBytes(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM artifacts WHERE run_id = ?')
      .get(runId) as { total: number };
    return row.total;
  }
}
