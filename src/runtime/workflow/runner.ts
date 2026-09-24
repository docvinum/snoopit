/**
 * Executing one run of one workflow.
 *
 * The runner owns the parts a workflow must not be able to get wrong: opening the
 * run, keeping its heartbeat, closing it exactly once whatever happened, and writing
 * the report. A workflow that throws still produces a `failed` run with a report
 * explaining why — an unexplained run is a defect, not an edge case.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { posix } from 'node:path';
import type { BrowserBackend } from '../browser/types.js';
import { PageTracker } from '../browser/tracking.js';
import { RunEventEmitter } from '../events/emitter.js';
import { runDir } from '../downloads/paths.js';
import { buildReport } from '../../outputs/report.js';
import type { Store } from '../../state/store.js';
import type { Job, Run, RunBudget, RunEvent, RunTrigger } from '../../state/types.js';
import {
  BudgetExceededError,
  BudgetGuard,
  effectiveBudget,
  type LooseBudget,
} from '../budget/guard.js';
import { BlockedError } from '../recovery/blocking.js';
import { AuthRequiredError } from '../navigation/session.js';
import type { LlmProvider } from '../recovery/llm/provider.js';
import { isoFromNow } from '../../util/time.js';
import { RunContext } from './context.js';
import type { WorkflowDefinition } from './types.js';

export interface RunWorkflowOptions {
  readonly store: Store;
  readonly job: Job;
  readonly browser: BrowserBackend;
  /** Absolute path of the data directory. */
  readonly dataDir: string;
  readonly trigger?: RunTrigger;
  /** Overrides the workflow's and the job's budget for this run. */
  readonly budget?: RunBudget | null;
  /**
   * Limits applied to whatever the run's budget leaves unset — `defaultBudget` in
   * the config. A workflow without a budget gets all of them.
   */
  readonly defaultBudget?: LooseBudget | null;
  /** Heartbeat interval. A `running` row with a stale heartbeat is a crashed run. */
  readonly heartbeatMs?: number;
  /**
   * How long a run may go without a heartbeat before it counts as dead. Must exceed
   * the heartbeat interval comfortably, or a slow run declares itself abandoned.
   */
  readonly staleAfterMs?: number;
  /** Cap on frontier entries this run may claim, from the job's `pagesPerRun`. */
  readonly pagesPerRun?: number | null;
  /** Absent means recovery stops at L1 — a valid, fully supported configuration. */
  readonly llm?: LlmProvider | null;
  readonly onLine?: (line: string) => void;
}

/** Raised when another run of the same job is genuinely alive. */
export class RunOverlapError extends Error {
  constructor(readonly activeRunId: string) {
    super(`Job already has a live run: ${activeRunId}`);
    this.name = 'RunOverlapError';
  }
}

export interface RunOutcome {
  readonly run: Run;
  readonly result: unknown;
  /** Data-dir-relative paths of the two reports. */
  readonly reportPath: string;
  readonly reportJsonPath: string;
  readonly error: Error | null;
  /** The budget limit that stopped the run, if any. Not a failure. */
  readonly budgetLimit: string | null;
  /** Set when the site refused us. The run stopped on purpose. */
  readonly blocked: BlockedError | null;
  /** Set when a page that needs a session hit a login wall. A person must log in. */
  readonly authRequired: AuthRequiredError | null;
  /** Frontier entries returned to the queue from previously crashed runs. */
  readonly reclaimed: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
/** Five missed heartbeats. Generous on purpose: declaring a live run dead is worse. */
const DEFAULT_STALE_AFTER_MS = 5 * DEFAULT_HEARTBEAT_MS;

export async function runWorkflow<T>(
  definition: WorkflowDefinition<T>,
  options: RunWorkflowOptions,
): Promise<RunOutcome> {
  const { store, job, dataDir } = options;
  const budget = effectiveBudget(
    options.budget ?? definition.budget ?? job.budget ?? null,
    options.defaultBudget,
  );

  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const staleCutoff = isoFromNow(-staleAfterMs);

  // Overlap lock. A *live* run blocks a second one; a dead one must never block the
  // job forever, which is the distinction a heartbeat expresses and a lock file
  // cannot.
  const active = store.runs.findActive(job.id, staleCutoff);
  if (active !== null) throw new RunOverlapError(active.id);

  // Close out runs whose process died, then return their abandoned work to the
  // queue. Without this, a killed run's leased entries are lost to every later run.
  for (const dead of store.runs.findStale(staleCutoff).filter((r) => r.jobId === job.id)) {
    store.runs.markAbandoned(dead.id);
  }
  const reclaimed = store.frontier.reclaimAbandonedLeases(job.id);

  const run = store.runs.start({
    jobId: job.id,
    trigger: options.trigger ?? 'manual',
    budget,
  });

  const runDirectory = runDir(job.id, run.id);
  const absoluteRunDir = resolve(dataDir, runDirectory);
  await mkdir(absoluteRunDir, { recursive: true });

  const events = new RunEventEmitter({
    store,
    jobId: job.id,
    runId: run.id,
    jsonlPath: resolve(absoluteRunDir, 'events.jsonl'),
    ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
  });

  // Keeps the run visibly alive. Unref'd so a finished process is never held open by it.
  const heartbeat = setInterval(() => {
    store.runs.heartbeat(run.id);
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  events.emit({
    type: 'RUN_STARTED',
    message: `${job.name} — ${definition.name}`,
    data: { workflow: definition.name, trigger: run.trigger, budget },
  });

  if (reclaimed > 0) {
    events.emit({
      type: 'RUN_STARTED',
      level: 'warn',
      message: `${String(reclaimed)} entrée(s) récupérée(s) d'un run interrompu`,
      data: { reclaimed },
    });
  }

  const guard = new BudgetGuard(budget);
  // Every page the workflow opens goes through the tracker, so the ones it leaves
  // open — usually because it threw before its `finally` — are closed below.
  const pages = new PageTracker(options.browser);
  const context = new RunContext({
    store,
    job,
    run,
    browser: pages,
    events,
    dataDir,
    budget: guard,
    pagesPerRun: options.pagesPerRun ?? null,
    llm: options.llm ?? null,
  });

  let result: unknown = null;
  let failure: Error | null = null;
  let budgetLimit: string | null = null;
  let blocked: BlockedError | null = null;
  let authRequired: AuthRequiredError | null = null;

  try {
    result = await definition.run(context);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      // Exhausting a budget is not a failure: the run did what it was allowed to
      // do, and the rest waits for the next one.
      budgetLimit = error.limit;
      events.emit({
        type: 'BUDGET_REACHED',
        level: 'warn',
        message: error.message,
        data: { limit: error.limit, used: error.used, max: error.max },
      });
    } else if (error instanceof BlockedError) {
      // The site told us to stop. That is an outcome to report, not a failure to
      // retry and never something to work around (spec §12).
      blocked = error;
      events.emit({
        type: 'BLOCKED',
        level: 'error',
        url: error.url,
        message: error.message,
        data: { reason: error.signal.reason, evidence: error.signal.evidence },
      });
    } else if (error instanceof AuthRequiredError) {
      // The session in the Chrome profile has expired. Retrying cannot fix that and
      // logging in automatically is not something snoopit does: stop and say so.
      authRequired = error;
      events.emit({
        type: 'AUTH_REQUIRED',
        level: 'error',
        url: error.url,
        message: error.message,
        data: { finalUrl: error.finalUrl, evidence: error.evidence },
      });
    } else {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    clearInterval(heartbeat);
  }

  // The Chrome is persistent: a tab left open here would still be open next week.
  const leakedPages = await pages.closeAll();

  // Work claimed but not finished goes back to the queue immediately, rather than
  // waiting out a lease that no one is holding any more.
  for (const entry of store.frontier.leasedBy(run.id)) {
    store.frontier.release(job.id, entry.canonicalUrl);
  }

  // Whatever happened above, the run is closed and reported exactly once.
  if (failure === null) {
    events.emit({
      type: 'RUN_COMPLETED',
      message:
        blocked !== null
          ? `Run arrêté : le site refuse l'accès (${blocked.signal.reason})`
          : authRequired !== null
            ? 'Run arrêté : session expirée, reconnexion manuelle requise'
            : budgetLimit === null
              ? 'Run terminé'
              : `Run terminé (budget ${budgetLimit})`,
      ...(leakedPages === 0 ? {} : { data: { leakedPages } }),
    });
  } else {
    events.emit({
      type: 'RUN_FAILED',
      level: 'error',
      message: failure.message,
      data: { stack: failure.stack ?? null, leakedPages },
    });
  }

  const finished =
    store.runs.finish(run.id, {
      status: failure === null ? 'completed' : 'failed',
      stopReason:
        failure !== null
          ? 'error'
          : blocked !== null
            ? `blocked:${blocked.signal.reason}`
            : authRequired !== null
              ? 'auth-required'
              : budgetLimit === null
                ? 'done'
                : `budget:${budgetLimit}`,
      error: failure === null ? null : failure.message,
      reportPath: posix.join(runDirectory, 'report.md'),
    }) ?? run;

  const problems = store.events
    .listByRun(run.id)
    .filter((event: RunEvent) => event.level !== 'info');

  const report = buildReport({
    run: finished,
    jobName: job.name,
    workflow: definition.name,
    pageCounts: store.pages.countByStatus(job.id),
    frontierCounts: store.frontier.countByState(job.id),
    eventCounts: events.countsByType(),
    artifacts: store.artifacts.listByRun(run.id),
    problems,
    result,
    budget: budget as Readonly<Record<string, unknown>> | null,
  });

  await writeFile(resolve(absoluteRunDir, 'report.md'), report.markdown, 'utf8');
  await writeFile(resolve(absoluteRunDir, 'report.json'), report.json, 'utf8');

  return {
    run: finished,
    result,
    reportPath: posix.join(runDirectory, 'report.md'),
    reportJsonPath: posix.join(runDirectory, 'report.json'),
    error: failure,
    budgetLimit,
    blocked,
    authRequired,
    reclaimed,
  };
}
