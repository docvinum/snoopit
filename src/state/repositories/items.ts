import type { Db } from '../db.js';
import { diffFields, fieldsHash } from '../item-diff.js';
import { fromJson, orNull, toJson } from '../row.js';
import type {
  Item,
  ItemChange,
  ItemChangeKind,
  ItemDiff,
  ItemFields,
  ItemStatus,
  ObservationStatus,
} from '../types.js';
import { nowIso } from '../../util/time.js';

interface ItemRow {
  id: number;
  job_id: string;
  kind: string;
  key: string;
  fields_json: string;
  fields_hash: string;
  status: ItemStatus;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string | null;
  gone_at: string | null;
  last_run_id: string | null;
  seen_count: number;
  change_count: number;
}

interface ItemChangeRow {
  id: number;
  item_id: number;
  run_id: string | null;
  at: string;
  change: ItemChangeKind;
  diff_json: string | null;
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    key: row.key,
    fields: fromJson<ItemFields>(row.fields_json) ?? {},
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    goneAt: row.gone_at,
    lastRunId: row.last_run_id,
    seenCount: row.seen_count,
    changeCount: row.change_count,
  };
}

function toChange(row: ItemChangeRow): ItemChange {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    at: row.at,
    change: row.change,
    diff: fromJson<ItemDiff>(row.diff_json),
  };
}

export interface ObserveItemInput {
  readonly jobId: string;
  readonly kind: string;
  readonly key: string;
  readonly fields: ItemFields;
  readonly runId: string | null;
  readonly at?: string;
}

export interface ObserveItemResult {
  readonly status: ObservationStatus;
  readonly item: Item;
  /** Field-level changes since the previous observation. Empty unless something moved. */
  readonly diff: ItemDiff;
}

/**
 * Items a job follows by the site's own identifier.
 *
 * The identity is `(job, kind, key)`. Each observation is compared with the last
 * one and its outcome recorded in `item_changes`, so "what moved since yesterday"
 * and "the price history of this ad" are both queries on the record.
 */
export class ItemRepository {
  constructor(private readonly db: Db) {}

  observe(input: ObserveItemInput): ObserveItemResult {
    const at = input.at ?? nowIso();
    const hash = fieldsHash(input.fields);
    const fieldsJson = JSON.stringify(input.fields);

    return this.db.transaction((): ObserveItemResult => {
      const existing = this.row(input.jobId, input.kind, input.key);

      if (existing === null) {
        const result = this.db
          .prepare(
            `INSERT INTO items (job_id, kind, key, fields_json, fields_hash, status,
                                first_seen_at, last_seen_at, last_run_id)
             VALUES (?, ?, ?, ?, ?, 'present', ?, ?, ?)`,
          )
          .run(input.jobId, input.kind, input.key, fieldsJson, hash, at, at, input.runId);
        this.recordChange(Number(result.lastInsertRowid), input.runId, at, 'new', null);
        return {
          status: 'new',
          item: this.get(input.jobId, input.kind, input.key)!,
          diff: {},
        };
      }

      const before = fromJson<ItemFields>(existing.fields_json) ?? {};
      const diff = hash === existing.fields_hash ? {} : diffFields(before, input.fields);
      const moved = Object.keys(diff).length > 0;
      const returned = existing.status === 'gone';

      this.db
        .prepare(
          `UPDATE items
              SET fields_json = ?, fields_hash = ?, status = 'present', gone_at = NULL,
                  last_seen_at = ?, last_run_id = ?, seen_count = seen_count + 1,
                  last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END,
                  change_count = change_count + ?
            WHERE id = ?`,
        )
        .run(fieldsJson, hash, at, input.runId, moved ? 1 : 0, at, moved ? 1 : 0, existing.id);

      const status: ObservationStatus = returned ? 'returned' : moved ? 'changed' : 'unchanged';
      if (status !== 'unchanged') {
        this.recordChange(existing.id, input.runId, at, status, moved ? diff : null);
      }
      return { status, item: this.get(input.jobId, input.kind, input.key)!, diff };
    })();
  }

  /**
   * Marks as gone every present item of `kind` that `runId` did not observe.
   *
   * Only meaningful when the run saw the *whole* set: calling it after reading the
   * first page of a list would declare everything on page two gone. Scope `kind`
   * accordingly — e.g. `annonce:<search>` per saved search.
   *
   * @returns the items that were just marked gone.
   */
  markMissing(input: {
    readonly jobId: string;
    readonly kind: string;
    readonly runId: string;
    readonly at?: string;
  }): Item[] {
    const at = input.at ?? nowIso();
    return this.db.transaction((): Item[] => {
      const missing = (
        this.db
          .prepare(
            `SELECT * FROM items
              WHERE job_id = ? AND kind = ? AND status = 'present'
                AND (last_run_id IS NULL OR last_run_id != ?)
              ORDER BY id`,
          )
          .all(input.jobId, input.kind, input.runId) as ItemRow[]
      ).map(toItem);

      const markGone = this.db.prepare(
        `UPDATE items SET status = 'gone', gone_at = ? WHERE id = ?`,
      );
      for (const item of missing) {
        markGone.run(at, item.id);
        this.recordChange(item.id, input.runId, at, 'gone', null);
      }
      return missing.map((item) => ({ ...item, status: 'gone' as const, goneAt: at }));
    })();
  }

  get(jobId: string, kind: string, key: string): Item | null {
    const row = this.row(jobId, kind, key);
    return row === null ? null : toItem(row);
  }

  private row(jobId: string, kind: string, key: string): ItemRow | null {
    const row = this.db
      .prepare('SELECT * FROM items WHERE job_id = ? AND kind = ? AND key = ?')
      .get(jobId, kind, key) as ItemRow | undefined;
    return row ?? null;
  }

  list(
    jobId: string,
    options: { readonly kind?: string; readonly status?: ItemStatus; readonly limit?: number } = {},
  ): Item[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM items
            WHERE job_id = ?
              AND (? IS NULL OR kind = ?)
              AND (? IS NULL OR status = ?)
            ORDER BY kind, id
            LIMIT ?`,
        )
        .all(
          jobId,
          orNull(options.kind),
          orNull(options.kind),
          orNull(options.status),
          orNull(options.status),
          options.limit ?? 1000,
        ) as ItemRow[]
    ).map(toItem);
  }

  /** Every recorded appearance, change, disappearance and return, oldest first. */
  history(itemId: number): ItemChange[] {
    return (
      this.db
        .prepare('SELECT * FROM item_changes WHERE item_id = ? ORDER BY id')
        .all(itemId) as ItemChangeRow[]
    ).map(toChange);
  }

  countByStatus(jobId: string, kind?: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM items
          WHERE job_id = ? AND (? IS NULL OR kind = ?)
          GROUP BY status`,
      )
      .all(jobId, orNull(kind), orNull(kind)) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.n]));
  }

  private recordChange(
    itemId: number,
    runId: string | null,
    at: string,
    change: ItemChangeKind,
    diff: ItemDiff | null,
  ): void {
    this.db
      .prepare(
        'INSERT INTO item_changes (item_id, run_id, at, change, diff_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(itemId, runId, at, change, toJson(diff));
  }
}
