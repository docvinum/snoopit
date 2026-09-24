import { openDatabase, schemaVersion, type Db, type OpenDatabaseOptions } from './db.js';
import { ArtifactRepository } from './repositories/artifacts.js';
import { EventRepository } from './repositories/events.js';
import { FrontierRepository } from './repositories/frontier.js';
import { ItemRepository } from './repositories/items.js';
import { JobRepository } from './repositories/jobs.js';
import { PageRepository } from './repositories/pages.js';
import { RunRepository } from './repositories/runs.js';

/**
 * The state layer, assembled.
 *
 * Everything durable in snoopit goes through a `Store`. Nothing else in the codebase
 * opens the database, and the browser never holds state that is not mirrored here
 * (decision D4).
 */
export class Store {
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly pages: PageRepository;
  readonly frontier: FrontierRepository;
  readonly artifacts: ArtifactRepository;
  readonly events: EventRepository;
  readonly items: ItemRepository;

  constructor(readonly db: Db) {
    this.jobs = new JobRepository(db);
    this.runs = new RunRepository(db);
    this.pages = new PageRepository(db);
    this.frontier = new FrontierRepository(db);
    this.artifacts = new ArtifactRepository(db);
    this.events = new EventRepository(db);
    this.items = new ItemRepository(db);
  }

  static open(options: OpenDatabaseOptions): Store {
    return new Store(openDatabase(options));
  }

  /** In-memory store, migrated. The test suite runs on this. */
  static memory(): Store {
    return Store.open({ path: ':memory:' });
  }

  get schemaVersion(): number {
    return schemaVersion(this.db);
  }

  /** Runs `fn` in a transaction; a throw rolls back every write inside it. */
  transaction<T>(fn: (store: Store) => T): T {
    return this.db.transaction(() => fn(this))();
  }

  close(): void {
    this.db.close();
  }
}
