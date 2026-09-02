/**
 * Numbered schema migrations.
 *
 * Migrations are TypeScript modules rather than loose `.sql` files on purpose: they
 * are then part of the compiled output, so a built `dist/` cannot drift from the
 * schema it expects, and there is no runtime file lookup to get wrong.
 *
 * Rules:
 *  - A migration that has shipped is immutable. Fix forward with a new one.
 *  - `id` is contiguous and ascending. The runner refuses gaps.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const M001_INIT = `
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  workflow        TEXT NOT NULL,
  browser_profile TEXT NOT NULL DEFAULT 'desktop-chrome',
  network_profile TEXT NOT NULL DEFAULT 'direct',
  schedule_json   TEXT,
  budget_json     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status            TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','aborted')),
  trigger           TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  heartbeat_at      TEXT,
  budget_json       TEXT,
  stop_reason       TEXT,
  error             TEXT,
  pages_visited     INTEGER NOT NULL DEFAULT 0,
  pages_discovered  INTEGER NOT NULL DEFAULT 0,
  artifacts_created INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes  INTEGER NOT NULL DEFAULT 0,
  llm_calls         INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  report_path       TEXT
);
CREATE INDEX idx_runs_job    ON runs(job_id, started_at DESC);
CREATE INDEX idx_runs_status ON runs(status, heartbeat_at);

-- What we know about a URL, across all runs. The memory of the system.
CREATE TABLE crawl_pages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  canonical_url    TEXT NOT NULL,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  last_visited_at  TEXT,
  last_changed_at  TEXT,
  content_hash     TEXT,
  status           TEXT NOT NULL CHECK (status IN ('discovered','visited','changed','gone','error','revisit')),
  http_status      INTEGER,
  title            TEXT,
  visit_count      INTEGER NOT NULL DEFAULT 0,
  error_count      INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_visit_after TEXT,
  -- Identity is the canonical URL, never a page number. This is what makes
  -- resumption robust to insertions, removals and reordering (spec §8).
  UNIQUE (job_id, canonical_url)
);
CREATE INDEX idx_pages_status  ON crawl_pages(job_id, status);
CREATE INDEX idx_pages_revisit ON crawl_pages(job_id, next_visit_after);

-- What is left to do. Consumed by the collection phase (decision D5).
CREATE TABLE crawl_frontier (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  canonical_url   TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','asset','document')),
  state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','done','failed','skipped')),
  priority        INTEGER NOT NULL DEFAULT 100,
  depth           INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  available_after TEXT,
  lease_run_id    TEXT,
  lease_expires_at TEXT,
  last_error      TEXT,
  meta_json       TEXT,
  discovered_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (job_id, canonical_url)
);
CREATE INDEX idx_frontier_take  ON crawl_frontier(job_id, state, priority, depth, id);
CREATE INDEX idx_frontier_lease ON crawl_frontier(state, lease_expires_at);

CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  page_id       INTEGER REFERENCES crawl_pages(id) ON DELETE SET NULL,
  source_url    TEXT,
  canonical_url TEXT,
  kind          TEXT NOT NULL,
  path          TEXT NOT NULL,
  media_type    TEXT,
  bytes         INTEGER,
  content_hash  TEXT,
  created_at    TEXT NOT NULL,
  meta_json     TEXT
);
CREATE INDEX idx_artifacts_job  ON artifacts(job_id, created_at DESC);
CREATE INDEX idx_artifacts_run  ON artifacts(run_id);
CREATE INDEX idx_artifacts_hash ON artifacts(job_id, content_hash);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL,
  run_id        TEXT,
  at            TEXT NOT NULL,
  type          TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  url           TEXT,
  canonical_url TEXT,
  message       TEXT,
  data_json     TEXT
);
CREATE INDEX idx_events_run  ON events(run_id, id);
CREATE INDEX idx_events_type ON events(job_id, type, at);
`;

export const MIGRATIONS: readonly Migration[] = [{ id: 1, name: 'init', sql: M001_INIT }];
