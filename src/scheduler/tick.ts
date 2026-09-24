/**
 * One scheduler pass: run each due job once, in turn.
 *
 * Separated from the CLI so the one property that matters here can be tested
 * without a browser: **one job failing never stops the pass.** A workflow that no
 * longer exists, a Chrome that is momentarily unreachable, a run that throws — each
 * fails *its* job, and every other job due in the same tick still runs.
 */

import type { BrowserBackend } from '../runtime/browser/types.js';
import { runWorkflow, type RunWorkflowOptions } from '../runtime/workflow/runner.js';
import type { WorkflowDefinition } from '../runtime/workflow/types.js';
import type { Store } from '../state/store.js';
import type { JobDecision } from './scheduler.js';

export interface TickDeps {
  readonly store: Store;
  readonly loadWorkflow: (name: string) => Promise<WorkflowDefinition>;
  readonly connect: () => Promise<BrowserBackend>;
  /** Options shared by every run of the pass. */
  readonly runOptions: Omit<
    RunWorkflowOptions,
    'store' | 'job' | 'browser' | 'trigger' | 'pagesPerRun'
  >;
  /** Receives one line per finished run. Output is the caller's business (the CLI). */
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export interface TickResult {
  readonly ran: number;
  readonly failures: number;
}

export async function runDueJobs(due: readonly JobDecision[], deps: TickDeps): Promise<TickResult> {
  const { log, logError } = deps;
  let failures = 0;
  for (const { job, pagesPerRun } of due) {
    let browser: BrowserBackend | null = null;
    try {
      const definition = await deps.loadWorkflow(job.workflow);
      browser = await deps.connect();
      const outcome = await runWorkflow(definition, {
        ...deps.runOptions,
        store: deps.store,
        job,
        browser,
        trigger: 'schedule',
        pagesPerRun,
      });
      log(`${job.id}: ${outcome.run.status} (${outcome.run.stopReason ?? '—'})`);
      if (outcome.error !== null) failures += 1;
    } catch (error) {
      logError(`${job.id}: ${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
    } finally {
      await browser?.close();
    }
  }
  return { ran: due.length, failures };
}
