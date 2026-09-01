import type { Db } from '../db.js';
import { jobId as makeJobId } from '../ids.js';
import { fromBool, fromJson, orNull, toBool, toJson } from '../row.js';
import type { Job, JobSchedule, RunBudget } from '../types.js';
import { nowIso } from '../../util/time.js';

interface JobRow {
  id: string;
  name: string;
  workflow: string;
  browser_profile: string;
  network_profile: string;
  schedule_json: string | null;
  budget_json: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface JobInput {
  readonly name: string;
  readonly workflow: string;
  readonly browserProfile?: string;
  readonly networkProfile?: string;
  readonly schedule?: JobSchedule | null;
  readonly budget?: RunBudget | null;
  readonly enabled?: boolean;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    workflow: row.workflow,
    browserProfile: row.browser_profile,
    networkProfile: row.network_profile,
    schedule: fromJson<JobSchedule>(row.schedule_json),
    budget: fromJson<RunBudget>(row.budget_json),
    enabled: toBool(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /** Creates or updates a job, keyed by its slugified name. */
  upsert(input: JobInput): Job {
    const id = makeJobId(input.name);
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, workflow, browser_profile, network_profile,
                           schedule_json, budget_json, enabled, created_at, updated_at)
         VALUES (@id, @name, @workflow, @browserProfile, @networkProfile,
                 @schedule, @budget, @enabled, @at, @at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           workflow = excluded.workflow,
           browser_profile = excluded.browser_profile,
           network_profile = excluded.network_profile,
           schedule_json = excluded.schedule_json,
           budget_json = excluded.budget_json,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        name: input.name,
        workflow: input.workflow,
        browserProfile: input.browserProfile ?? 'desktop-chrome',
        networkProfile: input.networkProfile ?? 'direct',
        schedule: toJson(orNull(input.schedule)),
        budget: toJson(orNull(input.budget)),
        enabled: fromBool(input.enabled ?? true),
        at,
      });
    return this.get(id)!;
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row === undefined ? null : toJob(row);
  }

  list(options: { readonly enabledOnly?: boolean } = {}): Job[] {
    const sql =
      options.enabledOnly === true
        ? 'SELECT * FROM jobs WHERE enabled = 1 ORDER BY id'
        : 'SELECT * FROM jobs ORDER BY id';
    return (this.db.prepare(sql).all() as JobRow[]).map(toJob);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE jobs SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(fromBool(enabled), nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
}
