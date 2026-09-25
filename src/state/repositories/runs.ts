import type { Db } from '../db.js';
import { runId as makeRunId } from '../ids.js';
import { fromJson, orNull, toJson } from '../row.js';
import type { Run, RunBudget, RunCounterName, RunStatus, RunTrigger } from '../types.js';
import { nowIso } from '../../util/time.js';

interface RunRow {
  id: string;
  job_id: string;
  status: RunStatus;
  trigger: RunTrigger;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  budget_json: string | null;
  stop_reason: string | null;
  error: string | null;
  pages_visited: number;
  pages_discovered: number;
  artifacts_created: number;
  downloaded_bytes: number;
  error_count: number;
  report_path: string | null;
}

/** Maps a counter name to its column. Keeps `increment` from taking raw SQL. */
const COUNTER_COLUMNS: Record<RunCounterName, string> = {
  pagesVisited: 'pages_visited',
  pagesDiscovered: 'pages_discovered',
  artifactsCreated: 'artifacts_created',
  downloadedBytes: 'downloaded_bytes',
  errorCount: 'error_count',
};

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    heartbeatAt: row.heartbeat_at,
    budget: fromJson<RunBudget>(row.budget_json),
    stopReason: row.stop_reason,
    error: row.error,
    counters: {
      pagesVisited: row.pages_visited,
      pagesDiscovered: row.pages_discovered,
      artifactsCreated: row.artifacts_created,
      downloadedBytes: row.downloaded_bytes,
      errorCount: row.error_count,
    },
    reportPath: row.report_path,
  };
}

export interface StartRunInput {
  readonly jobId: string;
  readonly trigger: RunTrigger;
  readonly budget?: RunBudget | null;
  readonly id?: string;
}

export interface FinishRunInput {
  readonly status: Extract<RunStatus, 'completed' | 'failed' | 'aborted'>;
  readonly stopReason?: string | null;
  readonly error?: string | null;
  readonly reportPath?: string | null;
}

export class RunRepository {
  constructor(private readonly db: Db) {}

  start(input: StartRunInput): Run {
    const id = input.id ?? makeRunId();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, job_id, status, trigger, started_at, heartbeat_at, budget_json)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(id, input.jobId, input.trigger, at, at, toJson(orNull(input.budget)));
    return this.get(id)!;
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  listByJob(jobId: string, limit = 50): Run[] {
    return (
      this.db
        .prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(jobId, limit) as RunRow[]
    ).map(toRun);
  }

  latestForJob(jobId: string): Run | null {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(jobId) as RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  /** Adds `by` to one counter and returns nothing; call sites read the run if needed. */
  increment(id: string, counter: RunCounterName, by = 1): void {
    const column = COUNTER_COLUMNS[counter];
    this.db.prepare(`UPDATE runs SET ${column} = ${column} + ? WHERE id = ?`).run(by, id);
  }

  /** Marks the run as still alive. A stale heartbeat is how a crash is detected. */
  heartbeat(id: string, at: string = nowIso()): void {
    this.db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(at, id);
  }

  finish(id: string, input: FinishRunInput): Run | null {
    this.db
      .prepare(
        `UPDATE runs
            SET status = ?, finished_at = ?, stop_reason = ?, error = ?,
                report_path = COALESCE(?, report_path)
          WHERE id = ?`,
      )
      .run(
        input.status,
        nowIso(),
        orNull(input.stopReason),
        orNull(input.error),
        orNull(input.reportPath),
        id,
      );
    return this.get(id);
  }

  /**
   * A run of this job that is still alive, or `null`.
   *
   * "Alive" means `running` with a heartbeat newer than `cutoff`. This is the
   * overlap lock: a job must not start a second run while one is genuinely working,
   * but a *dead* run must never block the job forever — which is exactly the
   * difference a heartbeat can express and a lock file cannot.
   */
  findActive(jobId: string, cutoffIso: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
          WHERE job_id = ?
            AND status = 'running'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at > ?
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get(jobId, cutoffIso) as RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  /**
   * Closes a run that was left `running` by a killed process.
   *
   * Recorded as `aborted` with an explicit reason rather than deleted: the run
   * happened, it did work, and its artifacts and events are still on disk. Erasing
   * it would make the record lie about what the system did.
   */
  markAbandoned(id: string, reason = 'process died'): Run | null {
    this.db
      .prepare(
        `UPDATE runs
            SET status = 'aborted', finished_at = ?, stop_reason = 'abandoned', error = ?
          WHERE id = ? AND status = 'running'`,
      )
      .run(nowIso(), reason, id);
    return this.get(id);
  }

  /**
   * Runs still marked `running` whose heartbeat predates `cutoff`.
   *
   * This is the crash-recovery query: a process killed mid-run leaves its row
   * `running` forever, and a later run uses this to reclaim it. Lot 4 acts on it.
   */
  findStale(cutoffIso: string): Run[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs
            WHERE status = 'running'
              AND (heartbeat_at IS NULL OR heartbeat_at < ?)
            ORDER BY started_at`,
        )
        .all(cutoffIso) as RunRow[]
    ).map(toRun);
  }
}
