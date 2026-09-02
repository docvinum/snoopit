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
  /** Why the run stopped: `done`, `budget:max_pages`, `blocked`, `error`. */
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
