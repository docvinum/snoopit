/** Deterministic recovery for an unexpected page state. */

import {
  BlockedError,
  detectBlocking,
  BLOCKING_PROBE_SELECTORS,
  type BlockSignal,
} from './blocking.js';
import { dismissOverlays, type DismissCandidate } from './heuristics.js';
import { isHumanInteractable } from '../browser/interactable.js';
import type { PageHandle } from '../browser/types.js';

export type RecoveryLevel = 'L1';
export type RecoveryActionName = 'click' | 'scroll' | 'close_overlay';

export interface ExpectedState {
  readonly selector: string;
}

export interface RecoverOptions {
  /** Human-readable intent for logs and the terminal caller. */
  readonly goal: string;
  readonly expectedState: ExpectedState;
  readonly allowedActions?: readonly RecoveryActionName[];
}

export interface RecoveryStep {
  readonly level: RecoveryLevel;
  readonly action: string;
  readonly target: string | null;
  readonly reason: string;
  readonly applied: boolean;
}

export interface RecoveryOutcome {
  readonly recovered: boolean;
  readonly level: RecoveryLevel | null;
  readonly steps: readonly RecoveryStep[];
}

export class RecoveryFailedError extends Error {
  constructor(
    readonly goal: string,
    readonly outcome: RecoveryOutcome,
  ) {
    super(
      `Recovery failed for "${goal}" after ${String(outcome.steps.length)} deterministic step(s)`,
    );
    this.name = 'RecoveryFailedError';
  }
}

export interface RecoveryDeps {
  readonly onStep?: (step: RecoveryStep) => void;
}

const DEFAULT_ACTIONS: readonly RecoveryActionName[] = ['click', 'scroll', 'close_overlay'];

async function expectedStateReached(page: PageHandle, expected: ExpectedState): Promise<boolean> {
  const element = await page.query(expected.selector);
  return element !== null && isHumanInteractable(element.view).interactable;
}

export async function probeBlocking(
  page: PageHandle,
  options: { readonly text?: boolean } = {},
): Promise<BlockSignal | null> {
  const present: string[] = [];
  if ((await page.query(BLOCKING_PROBE_SELECTORS.join(', '))) !== null) {
    for (const selector of BLOCKING_PROBE_SELECTORS) {
      if ((await page.query(selector)) !== null) present.push(selector);
    }
  }
  return detectBlocking({
    url: page.url(),
    status: page.status(),
    text: options.text === false ? '' : (await page.text()).slice(0, 4000),
    selectorsPresent: present,
  });
}

async function assertNotBlocked(page: PageHandle): Promise<void> {
  const signal = await probeBlocking(page);
  if (signal !== null) throw new BlockedError(page.url(), signal);
}

/**
 * Applies the fixed, auditable L1 sequence only. A model outside snoopit may use
 * its reports to decide the next requested workflow action; snoopit never calls it.
 */
export async function recover(
  page: PageHandle,
  options: RecoverOptions,
  deps: RecoveryDeps = {},
): Promise<RecoveryOutcome> {
  const allowed = options.allowedActions ?? DEFAULT_ACTIONS;
  const steps: RecoveryStep[] = [];
  const record = (step: RecoveryStep): void => {
    steps.push(step);
    deps.onStep?.(step);
  };
  const failed = (): never => {
    throw new RecoveryFailedError(options.goal, { recovered: false, level: null, steps });
  };

  if (await expectedStateReached(page, options.expectedState)) {
    return { recovered: true, level: null, steps };
  }
  await assertNotBlocked(page);

  if (allowed.includes('close_overlay')) {
    const dismissal = await dismissOverlays(page);
    for (const candidate of dismissal.dismissed) {
      record({
        level: 'L1',
        action: 'close_overlay',
        target: candidate.selector,
        reason: candidate.reason,
        applied: true,
      });
    }
    if (await expectedStateReached(page, options.expectedState)) {
      return { recovered: true, level: 'L1', steps };
    }
  }

  if (allowed.includes('scroll')) {
    await page.scroll('bottom');
    record({
      level: 'L1',
      action: 'scroll',
      target: null,
      reason: 'content may be below the fold',
      applied: true,
    });
    if (await expectedStateReached(page, options.expectedState)) {
      return { recovered: true, level: 'L1', steps };
    }
  }

  return failed();
}

export type { DismissCandidate };
