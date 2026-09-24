/**
 * Domain model persisted in SQLite.
 *
 * SQLite is the source of truth (decision D4). These types describe rows, and the
 * repositories are the only code allowed to translate between rows and them.
 */

// ─── Job ──────────────────────────────────────────────────────────────────────

export interface Job {
  readonly id: string;
  readonly name: string;
  /** Module path of the workflow, relative to `workflows/`. */
  readonly workflow: string;
  readonly browserProfile: string;
  readonly networkProfile: string;
  readonly schedule: JobSchedule | null;
  readonly budget: RunBudget | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobSchedule {
  /** `manual` runs only on demand; the others are picked up by the scheduler. */
  readonly frequency: 'manual' | 'hourly' | 'daily' | 'weekly';
  /** Optional time-of-day window; the scheduler picks a moment inside it. */
  readonly window?: { readonly from: string; readonly to: string };
  readonly pagesPerRun?: { readonly min: number; readonly max: number };
  /**
   * IANA zone the window is read in, e.g. `Europe/Paris`. When absent, the
   * scheduler's default applies (`scheduler.timeZone` in the config, or `--tz`).
   */
  readonly timeZone?: string;
}

export interface RunBudget {
  readonly maxPages?: number;
  /** Human duration, e.g. `20m`. Parsed with `parseDuration`. */
  readonly maxDuration?: string;
  readonly maxDownloadBytes?: number;
  readonly maxLlmCalls?: number;
  readonly maxErrors?: number;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
export type RunTrigger = 'manual' | 'schedule';

export interface Run {
  readonly id: string;
  readonly jobId: string;
  readonly status: RunStatus;
  readonly trigger: RunTrigger;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /**
   * Refreshed while a run is alive. A `running` row with a stale heartbeat is a
   * crashed run, which is how a later run reclaims work without a lock file.
   */
  readonly heartbeatAt: string | null;
  readonly budget: RunBudget | null;
  /**
   * Why the run stopped: `done`, `budget:<limit>`, `blocked:<reason>`,
   * `auth-required`, `error`, or `abandoned` for a run whose process died.
   */
  readonly stopReason: string | null;
  readonly error: string | null;
  readonly counters: RunCounters;
  readonly reportPath: string | null;
}

export interface RunCounters {
  readonly pagesVisited: number;
  readonly pagesDiscovered: number;
  readonly artifactsCreated: number;
  readonly downloadedBytes: number;
  readonly llmCalls: number;
  readonly errorCount: number;
}

export const ZERO_COUNTERS: RunCounters = {
  pagesVisited: 0,
  pagesDiscovered: 0,
  artifactsCreated: 0,
  downloadedBytes: 0,
  llmCalls: 0,
  errorCount: 0,
};

export type RunCounterName = keyof RunCounters;

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a known URL.
 *
 * `discovered` -> `visited` -> (`changed` | `gone` | `error`) -> `revisit`
 */
export type PageStatus = 'discovered' | 'visited' | 'changed' | 'gone' | 'error' | 'revisit';

export interface Page {
  readonly id: number;
  readonly jobId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastVisitedAt: string | null;
  readonly lastChangedAt: string | null;
  readonly contentHash: string | null;
  readonly status: PageStatus;
  readonly httpStatus: number | null;
  readonly title: string | null;
  readonly visitCount: number;
  readonly errorCount: number;
  readonly lastError: string | null;
  readonly nextVisitAfter: string | null;
}

// ─── Frontier ─────────────────────────────────────────────────────────────────

export type FrontierState = 'queued' | 'leased' | 'done' | 'failed' | 'skipped';
export type FrontierKind = 'page' | 'asset' | 'document';

export interface FrontierEntry {
  readonly id: number;
  readonly jobId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly kind: FrontierKind;
  readonly state: FrontierState;
  /** Lower runs sooner. */
  readonly priority: number;
  readonly depth: number;
  readonly attempts: number;
  readonly availableAfter: string | null;
  readonly leaseRunId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastError: string | null;
  readonly meta: Record<string, unknown> | null;
  readonly discoveredAt: string;
  readonly updatedAt: string;
}

// ─── Artifact ─────────────────────────────────────────────────────────────────

export type ArtifactKind =
  'markdown' | 'json' | 'html' | 'pdf' | 'image' | 'file' | 'screenshot' | 'report';

export interface Artifact {
  readonly id: number;
  readonly jobId: string;
  readonly runId: string | null;
  readonly pageId: number | null;
  readonly sourceUrl: string | null;
  readonly canonicalUrl: string | null;
  readonly kind: ArtifactKind;
  /** Path relative to the configured data directory, never absolute. */
  readonly path: string;
  readonly mediaType: string | null;
  readonly bytes: number | null;
  readonly contentHash: string | null;
  readonly createdAt: string;
  readonly meta: Record<string, unknown> | null;
}

// ─── Item ─────────────────────────────────────────────────────────────────────

/** A field value an item can carry. Kept scalar so a diff is always readable. */
export type ItemValue = string | number | boolean | null;
export type ItemFields = Readonly<Record<string, ItemValue>>;

export type ItemStatus = 'present' | 'gone';

/** Something a job follows by the site's own identifier, e.g. an ad id. */
export interface Item {
  readonly id: number;
  readonly jobId: string;
  /** Free-form family, e.g. `annonce` — or `annonce:<search>` to sweep per list. */
  readonly kind: string;
  /** The site's stable identifier within `kind`. */
  readonly key: string;
  readonly fields: ItemFields;
  readonly status: ItemStatus;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastChangedAt: string | null;
  readonly goneAt: string | null;
  readonly lastRunId: string | null;
  readonly seenCount: number;
  readonly changeCount: number;
}

/** How one field moved between two observations. */
export interface FieldChange {
  readonly from: ItemValue;
  readonly to: ItemValue;
}
export type ItemDiff = Readonly<Record<string, FieldChange>>;

/**
 * What an observation revealed.
 *
 * - `new`       — never seen before for this job and kind;
 * - `changed`   — seen before, and at least one field differs;
 * - `returned`  — had been marked gone, and is back (with its diff, if any);
 * - `unchanged` — seen before, identical.
 */
export type ObservationStatus = 'new' | 'changed' | 'returned' | 'unchanged';

export type ItemChangeKind = 'new' | 'changed' | 'gone' | 'returned';

export interface ItemChange {
  readonly id: number;
  readonly itemId: number;
  readonly runId: string | null;
  readonly at: string;
  readonly change: ItemChangeKind;
  readonly diff: ItemDiff | null;
}

// ─── Event ────────────────────────────────────────────────────────────────────

/** Domain events (spec §17). Deliberately not CDP events: these explain a run. */
export const EVENT_TYPES = [
  'RUN_STARTED',
  'PAGE_DISCOVERED',
  'PAGE_VISITED',
  'CONTENT_CHANGED',
  'ARTIFACT_CREATED',
  'HTTP_ERROR',
  'RECOVERY_STARTED',
  'RECOVERY_SUCCEEDED',
  'RECOVERY_FAILED',
  'BUDGET_REACHED',
  'BLOCKED',
  'AUTH_REQUIRED',
  'ITEM_NEW',
  'ITEM_CHANGED',
  'ITEM_GONE',
  'ITEM_RETURNED',
  'RUN_COMPLETED',
  'RUN_FAILED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type EventLevel = 'info' | 'warn' | 'error';

export interface RunEvent {
  readonly id: number;
  readonly jobId: string;
  readonly runId: string | null;
  readonly at: string;
  readonly type: EventType;
  readonly level: EventLevel;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly message: string | null;
  readonly data: Record<string, unknown> | null;
}
