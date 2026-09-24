/**
 * Recovery: getting a script back on its feet when a page is not what it expected.
 *
 * The escalation is monotonic and budgeted:
 *
 * ```text
 * L0  the script itself          — outside this module; the nominal path
 * L1  deterministic heuristics   — overlays, scroll, re-check. No LLM.
 * L2  LLM over a DOM digest      — text only, minimal context
 * L3  LLM with a screenshot      — last resort, most expensive
 * L4  explicit failure           — logged, reported, run stops honestly
 * ```
 *
 * Three properties matter more than cleverness.
 *
 * **The LLM is an exception, not a step.** Recovery starts at L1 and stops the
 * moment the expected state appears. A run that never meets a surprise never
 * reaches L2, and `llmCalls` in the report proves it.
 *
 * **The model chooses, it does not invent.** It is offered a list of controls we
 * already judged human-interactable, and an action naming anything else is refused.
 * It cannot conjure a selector for a hidden element, and it cannot act outside the
 * caller's `allowedActions`.
 *
 * **A block is never a recovery problem.** If the site is refusing us — CAPTCHA,
 * 403, rate limit — recovery stops immediately and the run ends explicitly. Asking
 * a model to get past a challenge is the behaviour this project refuses (spec §12).
 */

import {
  BlockedError,
  detectBlocking,
  BLOCKING_PROBE_SELECTORS,
  type BlockSignal,
} from './blocking.js';
import { collectControls, dismissOverlays, type DismissCandidate } from './heuristics.js';
import { isHumanInteractable } from '../browser/interactable.js';
import type { ElementSnapshot, PageHandle } from '../browser/types.js';
import type { LlmProvider } from './llm/provider.js';

export type RecoveryLevel = 'L1' | 'L2' | 'L3';

/** Actions a workflow may allow recovery to take. Nothing else is ever performed. */
export type RecoveryActionName = 'click' | 'scroll' | 'close_overlay';

export interface ExpectedState {
  /** The selector whose presence means the page is where the script wants it. */
  readonly selector: string;
}

export interface RecoverOptions {
  /** What the script was trying to reach, in one sentence. Sent to the model. */
  readonly goal: string;
  readonly expectedState: ExpectedState;
  /** Defaults to every action. Narrow it when a workflow must not click. */
  readonly allowedActions?: readonly RecoveryActionName[];
  /** Model-driven steps allowed per LLM level. Defaults to 3. */
  readonly maxSteps?: number;
  /** Stop before L2/L3 even when a provider exists. */
  readonly maxLevel?: RecoveryLevel;
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
  /** The level that succeeded, or `null` when none did. */
  readonly level: RecoveryLevel | null;
  readonly steps: readonly RecoveryStep[];
  readonly llmCalls: number;
}

/** L4: recovery exhausted every level without reaching the expected state. */
export class RecoveryFailedError extends Error {
  constructor(
    readonly goal: string,
    readonly outcome: RecoveryOutcome,
  ) {
    super(
      `Recovery failed for "${goal}" after ${String(outcome.steps.length)} step(s) ` +
        `and ${String(outcome.llmCalls)} LLM call(s)`,
    );
    this.name = 'RecoveryFailedError';
  }
}

export interface RecoveryDeps {
  /** Absent means L1 only — which is a perfectly valid configuration. */
  readonly llm?: LlmProvider | null;
  /** Called before each LLM call; throws when the run's LLM budget is spent. */
  readonly onLlmCall?: () => void;
  readonly onStep?: (step: RecoveryStep) => void;
}

const DEFAULT_ACTIONS: readonly RecoveryActionName[] = ['click', 'scroll', 'close_overlay'];

/** Has the page reached the state the script was waiting for? */
async function expectedStateReached(page: PageHandle, expected: ExpectedState): Promise<boolean> {
  const element = await page.query(expected.selector);
  return element !== null && isHumanInteractable(element.view).interactable;
}

/**
 * Looks at a page for signs that the site is refusing us.
 *
 * One combined query first: on the nominal path — no challenge on the page — that
 * is a single round trip instead of one per known widget. Only when something
 * matches are the selectors probed one by one, to name the evidence.
 *
 * `text: false` skips the wording checks, which are the weakest evidence: an
 * article that mentions "rate limit" is not a rate limit. `visit` only reads the
 * text of pages that already answered with an error status.
 */
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

/** Stops everything when the site has told us to stop. */
async function assertNotBlocked(page: PageHandle): Promise<void> {
  const signal = await probeBlocking(page);
  if (signal !== null) throw new BlockedError(page.url(), signal);
}

/** A stable selector for a control, preferring an id. */
function selectorFor(snapshot: ElementSnapshot, index: number): string {
  const id = snapshot.attributes['id'];
  if (id !== undefined && id !== '') return `#${id}`;
  return `${snapshot.tagName}:nth-of-type(${String(index + 1)})`;
}

/**
 * The page digest sent to the model.
 *
 * Only what is needed to choose an action: the goal's own context, and the controls
 * a person could actually operate. This stands in for a raw accessibility tree —
 * same information, already filtered to what may be acted on, and identical across
 * backends, which a computed a11y tree would not be.
 */
async function pageDigest(
  page: PageHandle,
): Promise<{ text: string; controls: ElementSnapshot[] }> {
  const controls = (await collectControls(page))
    .map((snapshot, index) => ({ ...snapshot, selector: selectorFor(snapshot, index) }))
    .filter((snapshot) => isHumanInteractable(snapshot.view).interactable)
    .slice(0, 40);

  const title = (await page.query('title'))?.text ?? '';
  const excerpt = (await page.text()).slice(0, 1200);

  const lines = [
    `URL: ${page.url()}`,
    `HTTP status: ${String(page.status() ?? 'n/a')}`,
    `Title: ${title}`,
    '',
    'Visible text (truncated):',
    excerpt,
    '',
    'Interactable controls:',
    ...controls.map(
      (control, index) =>
        `${String(index + 1)}. selector=${control.selector} tag=${control.tagName} text=${JSON.stringify(control.text.slice(0, 80))}`,
    ),
  ];
  return { text: lines.join('\n'), controls };
}

interface ProposedAction {
  readonly action: string;
  readonly selector?: string;
  readonly direction?: string;
  readonly reason?: string;
}

/** Parses the model's reply. A malformed reply is a failed step, never a crash. */
function parseAction(text: string): ProposedAction | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const action = (parsed as { action?: unknown }).action;
    if (typeof action !== 'string') return null;
    return parsed as ProposedAction;
  } catch {
    return null;
  }
}

function buildPrompt(
  goal: string,
  expected: ExpectedState,
  allowed: readonly RecoveryActionName[],
  digest: string,
): string {
  return [
    `Goal: ${goal}`,
    `The script is waiting for this selector to be present and interactable: ${expected.selector}`,
    '',
    'Page:',
    digest,
    '',
    `Choose ONE action from: ${allowed.join(', ')}, or give_up.`,
    'You may only reference a selector listed under "Interactable controls" above.',
    'Do not attempt to solve any human-verification challenge; answer give_up instead.',
    '',
    'Reply with JSON only, e.g.',
    '{"action":"click","selector":"#accept","reason":"consent banner covers the list"}',
    '{"action":"scroll","direction":"down","reason":"content loads further down"}',
    '{"action":"give_up","reason":"nothing on this page leads to the goal"}',
  ].join('\n');
}

/**
 * Attempts to reach `expectedState`, escalating only as far as it must.
 *
 * @throws RecoveryFailedError when every level is exhausted (L4).
 * @throws BlockedError when the site is refusing us — never retried, never worked around.
 */
export async function recover(
  page: PageHandle,
  options: RecoverOptions,
  deps: RecoveryDeps = {},
): Promise<RecoveryOutcome> {
  const allowed = options.allowedActions ?? DEFAULT_ACTIONS;
  const maxSteps = options.maxSteps ?? 3;
  const maxLevel = options.maxLevel ?? 'L3';
  const steps: RecoveryStep[] = [];
  let llmCalls = 0;

  const record = (step: RecoveryStep): void => {
    steps.push(step);
    deps.onStep?.(step);
  };

  const finish = (level: RecoveryLevel): RecoveryOutcome => ({
    recovered: true,
    level,
    steps,
    llmCalls,
  });

  // Already there: recovery is a no-op, which is the common case when a caller
  // guards every action with it.
  if (await expectedStateReached(page, options.expectedState)) {
    return { recovered: true, level: null, steps, llmCalls };
  }

  await assertNotBlocked(page);

  // ── L1 — deterministic ──────────────────────────────────────────────────
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
  if (await expectedStateReached(page, options.expectedState)) return finish('L1');

  if (allowed.includes('scroll')) {
    // Content below the fold is the other everyday reason a selector is missing.
    await page.scroll('bottom');
    record({
      level: 'L1',
      action: 'scroll',
      target: null,
      reason: 'content may be below the fold',
      applied: true,
    });
    if (await expectedStateReached(page, options.expectedState)) return finish('L1');
  }

  // ── L2 / L3 — the model, only if one is configured ──────────────────────
  const llm = deps.llm ?? null;
  if (llm === null || maxLevel === 'L1') {
    throw new RecoveryFailedError(options.goal, { recovered: false, level: null, steps, llmCalls });
  }

  const levels: RecoveryLevel[] = maxLevel === 'L2' ? ['L2'] : ['L2', 'L3'];
  let providerFailed = false;

  for (const level of levels) {
    if (providerFailed) break;
    if (level === 'L3' && !llm.supportsImages) continue;

    for (let step = 0; step < maxSteps; step += 1) {
      await assertNotBlocked(page);

      const digest = await pageDigest(page);
      const prompt = buildPrompt(options.goal, options.expectedState, allowed, digest.text);

      const content =
        level === 'L2'
          ? prompt
          : [
              { type: 'text' as const, text: prompt },
              {
                type: 'image' as const,
                mediaType: 'image/png',
                dataBase64: (await page.screenshot({ fullPage: false })).toString('base64'),
              },
            ];

      // Throws when the run's LLM budget is spent, which ends recovery immediately.
      deps.onLlmCall?.();
      llmCalls += 1;

      let reply;
      try {
        reply = await llm.complete({
          messages: [
            {
              role: 'system',
              content:
                'You help a deterministic web crawler get past an unexpected page state. ' +
                'Answer with a single JSON action and nothing else.',
            },
            { role: 'user', content },
          ],
          json: true,
          temperature: 0,
        });
      } catch (error) {
        // An unreachable or failing provider degrades to L4 rather than surfacing an
        // opaque transport error to the workflow. The provider is shared by every
        // level, so retrying the next one would only waste another call.
        record({
          level,
          action: 'llm-error',
          target: null,
          reason: error instanceof Error ? error.message : String(error),
          applied: false,
        });
        providerFailed = true;
        break;
      }

      const proposal = parseAction(reply.text);
      if (proposal === null) {
        record({
          level,
          action: 'invalid-reply',
          target: null,
          reason: 'model reply was not usable JSON',
          applied: false,
        });
        continue;
      }
      if (proposal.action === 'give_up') {
        record({
          level,
          action: 'give_up',
          target: null,
          reason: proposal.reason ?? '',
          applied: false,
        });
        break;
      }
      if (!allowed.includes(proposal.action as RecoveryActionName)) {
        record({
          level,
          action: proposal.action,
          target: null,
          reason: 'action not allowed by the workflow',
          applied: false,
        });
        continue;
      }

      if (proposal.action === 'scroll') {
        await page.scroll('bottom');
        record({
          level,
          action: 'scroll',
          target: null,
          reason: proposal.reason ?? '',
          applied: true,
        });
      } else {
        const selector = proposal.selector ?? '';
        // The model chooses among what we offered; it does not invent selectors.
        const offered = digest.controls.some((control) => control.selector === selector);
        if (!offered) {
          record({
            level,
            action: proposal.action,
            target: selector,
            reason: 'selector was not among the offered controls',
            applied: false,
          });
          continue;
        }
        try {
          await page.click(selector);
          record({
            level,
            action: proposal.action,
            target: selector,
            reason: proposal.reason ?? '',
            applied: true,
          });
        } catch (error) {
          record({
            level,
            action: proposal.action,
            target: selector,
            reason: error instanceof Error ? error.message : String(error),
            applied: false,
          });
          continue;
        }
      }

      if (await expectedStateReached(page, options.expectedState)) return finish(level);
    }
  }

  // ── L4 — explicit failure ───────────────────────────────────────────────
  throw new RecoveryFailedError(options.goal, { recovered: false, level: null, steps, llmCalls });
}

export type { DismissCandidate };
