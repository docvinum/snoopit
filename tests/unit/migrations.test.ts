import { describe, expect, it } from 'vitest';
import { appliedMigrations, migrate, openDatabase, schemaVersion } from '../../src/state/db.js';
import { MIGRATIONS } from '../../src/state/migrations.js';
import { Store } from '../../src/state/store.js';

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const store = Store.memory();
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(appliedMigrations(store.db)).toHaveLength(MIGRATIONS.length);
    store.close();
  });

  it('creates every expected table', () => {
    const store = Store.memory();
    const tables = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    for (const table of [
      'jobs',
      'runs',
      'crawl_pages',
      'crawl_frontier',
      'artifacts',
      'events',
      '_migrations',
    ]) {
      expect(tables).toContain(table);
    }
    store.close();
  });

  it('is idempotent — migrating twice applies nothing the second time', () => {
    const db = openDatabase({ path: ':memory:', migrate: false });
    expect(schemaVersion(db)).toBe(0);
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(0);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    db.close();
  });

  it('refuses a migration whose SQL changed after it was applied', () => {
    // Schema drift (risk R8) must fail loudly rather than silently no-op.
    const db = openDatabase({ path: ':memory:', migrate: false });
    migrate(db, [{ id: 1, name: 'init', sql: 'CREATE TABLE a (x TEXT);' }]);
    expect(() => migrate(db, [{ id: 1, name: 'init', sql: 'CREATE TABLE a (y TEXT);' }])).toThrow(
      /immutable/,
    );
    db.close();
  });

  it('refuses non-contiguous migration ids', () => {
    const db = openDatabase({ path: ':memory:', migrate: false });
    expect(() =>
      migrate(db, [
        { id: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT);' },
        { id: 3, name: 'c', sql: 'CREATE TABLE c (x TEXT);' },
      ]),
    ).toThrow(/contiguous/);
    db.close();
  });

  it('rolls back a failing migration entirely', () => {
    const db = openDatabase({ path: ':memory:', migrate: false });
    expect(() =>
      migrate(db, [{ id: 1, name: 'broken', sql: 'CREATE TABLE ok (x TEXT); THIS IS NOT SQL;' }]),
    ).toThrow();
    expect(schemaVersion(db)).toBe(0);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).not.toContain('ok');
    db.close();
  });

  it('enforces foreign keys', () => {
    const store = Store.memory();
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO runs (id, job_id, status, trigger, started_at) VALUES ('r', 'ghost', 'running', 'manual', 'now')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    store.close();
  });
});
