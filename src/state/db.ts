import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentHash } from '../util/hash.js';
import { nowIso } from '../util/time.js';
import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  /** `:memory:` is used by the test suite; anything else is created on demand. */
  readonly path: string;
  /** Apply pending migrations on open. Default: true. */
  readonly migrate?: boolean;
  readonly readonly?: boolean;
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

/**
 * Opens the state database and brings it up to date.
 *
 * WAL mode plus `foreign_keys` on: WAL because a long crawl writes continuously
 * while the CLI reads, and foreign keys because cascading deletes are the only
 * thing keeping orphan pages out when a job is removed.
 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }

  const db = new Database(options.path, { readonly: options.readonly === true });

  if (options.readonly !== true) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (options.migrate !== false && options.readonly !== true) {
    migrate(db);
  }
  return db;
}

/** Migrations already recorded in this database, ascending. */
export function appliedMigrations(db: Db): AppliedMigration[] {
  db.exec(MIGRATIONS_TABLE);
  return db
    .prepare('SELECT id, name, checksum, applied_at FROM _migrations ORDER BY id')
    .all() as AppliedMigration[];
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new Error(
        `Migration ids must be contiguous and ascending from 1; found ${String(migration.id)} at position ${String(index + 1)}`,
      );
    }
  });
}

/**
 * Applies every pending migration, each in its own transaction.
 *
 * An already-applied migration whose SQL has changed is a hard error rather than a
 * silent no-op. Schema drift between a developer's database and the committed
 * schema is risk R8 in the audit; this is where it gets caught.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number {
  assertContiguous(migrations);
  db.exec(MIGRATIONS_TABLE);

  const applied = new Map(appliedMigrations(db).map((row) => [row.id, row]));
  const record = db.prepare(
    'INSERT INTO _migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  let count = 0;
  for (const migration of migrations) {
    const checksum = contentHash(migration.sql);
    const previous = applied.get(migration.id);

    if (previous !== undefined) {
      if (previous.checksum !== checksum) {
        throw new Error(
          `Migration ${String(migration.id)} (${migration.name}) has changed since it was applied. ` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, checksum, nowIso());
    })();
    count += 1;
  }
  return count;
}

/** Highest applied migration id, or 0 on a fresh database. */
export function schemaVersion(db: Db): number {
  const rows = appliedMigrations(db);
  return rows.length === 0 ? 0 : rows[rows.length - 1]!.id;
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
