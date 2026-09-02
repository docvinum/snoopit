import type { Db } from '../db.js';
import { fromJson, orNull, toJson } from '../row.js';
import type { EventLevel, EventType, RunEvent } from '../types.js';
import { nowIso } from '../../util/time.js';

interface EventRow {
  id: number;
  job_id: string;
  run_id: string | null;
  at: string;
  type: EventType;
  level: EventLevel;
  url: string | null;
  canonical_url: string | null;
  message: string | null;
  data_json: string | null;
}

function toEvent(row: EventRow): RunEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    at: row.at,
    type: row.type,
    level: row.level,
    url: row.url,
    canonicalUrl: row.canonical_url,
    message: row.message,
    data: fromJson<Record<string, unknown>>(row.data_json),
  };
}

export interface AppendEventInput {
  readonly jobId: string;
  readonly runId?: string | null;
  readonly type: EventType;
  readonly level?: EventLevel;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly message?: string | null;
  readonly data?: Record<string, unknown> | null;
}

/**
 * Structured domain events — the record that makes a run explainable (spec §17).
 *
 * Events are not deleted on a schedule. The upstream project we audited expired its
 * event store after three minutes and its history after a day, which is exactly why
 * nothing there could be explained after the fact.
 */
export class EventRepository {
  constructor(private readonly db: Db) {}

  append(input: AppendEventInput): RunEvent {
    const info = this.db
      .prepare(
        `INSERT INTO events (job_id, run_id, at, type, level, url, canonical_url, message, data_json)
         VALUES (@jobId, @runId, @at, @type, @level, @url, @canonicalUrl, @message, @data)`,
      )
      .run({
        jobId: input.jobId,
        runId: orNull(input.runId),
        at: nowIso(),
        type: input.type,
        level: input.level ?? 'info',
        url: orNull(input.url),
        canonicalUrl: orNull(input.canonicalUrl),
        message: orNull(input.message),
        data: toJson(orNull(input.data)),
      });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): RunEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as
      EventRow | undefined;
    return row === undefined ? null : toEvent(row);
  }

  /** Events of a run, in the order they happened. */
  listByRun(runId: string, limit = 1000): RunEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE run_id = ? ORDER BY id LIMIT ?')
        .all(runId, limit) as EventRow[]
    ).map(toEvent);
  }

  listByType(jobId: string, type: EventType, limit = 100): RunEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE job_id = ? AND type = ? ORDER BY id DESC LIMIT ?')
        .all(jobId, type, limit) as EventRow[]
    ).map(toEvent);
  }

  countByType(runId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT type, COUNT(*) AS n FROM events WHERE run_id = ? GROUP BY type')
      .all(runId) as { type: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.type, row.n]));
  }
}
