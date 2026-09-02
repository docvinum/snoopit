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
import { RunEventEmitter } from '../events/emitter.js';
import { runDir } from '../downloads/paths.js';
import { buildReport } from '../../outputs/report.js';
import type { Store } from '../../state/store.js';
import type { Job, Run, RunBudget, RunEvent, RunTrigger } from '../../state/types.js';
import { RunContext } from './context.js';
import type { WorkflowDefinition } from './types.js';

export interface RunWorkflowOptions {
  readonly store: Store;
  readonly job: Job;
  readonly browser: BrowserBackend;
  /** Absolute path of the data directory. */
  readonly dataDir: string;
  readonly trigger?: RunTrigger;
  readonly budget?: RunBudget | null;
  /** Heartbeat interval. A `running` row with a stale heartbeat is a crashed run. */
  readonly heartbeatMs?: number;
  readonly onLine?: (line: string) => void;
}

export interface RunOutcome {
  readonly run: Run;
  readonly result: unknown;
  /** Data-dir-relative paths of the two reports. */
  readonly reportPath: string;
  readonly reportJsonPath: string;
  readonly error: Error | null;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export async function runWorkflow<T>(
  definition: WorkflowDefinition<T>,
  options: RunWorkflowOptions,
): Promise<RunOutcome> {
  const { store, job, dataDir } = options;
  const budget = options.budget ?? definition.budget ?? job.budget ?? null;

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

  const context = new RunContext({
    store,
    job,
    run,
    browser: options.browser,
    events,
    dataDir,
  });

  let result: unknown = null;
  let failure: Error | null = null;

  try {
    result = await definition.run(context);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearInterval(heartbeat);
  }

  // Whatever happened above, the run is closed and reported exactly once.
  if (failure === null) {
    events.emit({ type: 'RUN_COMPLETED', message: 'Run terminé' });
  } else {
    events.emit({
      type: 'RUN_FAILED',
      level: 'error',
      message: failure.message,
      data: { stack: failure.stack ?? null },
    });
  }

  const finished =
    store.runs.finish(run.id, {
      status: failure === null ? 'completed' : 'failed',
      stopReason: failure === null ? 'done' : 'error',
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
  };
}
