/**
 * The recovery escalation, on both backends.
 *
 * The property that matters most is negative: an overlay must be cleared at L1 with
 * the model never consulted. Everything else here — escalation, guardrails, budgets
 * — is verified against a scripted provider, because those are properties of our
 * code and a real endpoint would make the suite slow, costly and non-deterministic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpBackend } from '../../src/runtime/browser/cdp.js';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import type { BrowserBackend } from '../../src/runtime/browser/types.js';
import { BlockedError } from '../../src/runtime/recovery/blocking.js';
import { dismissOverlays } from '../../src/runtime/recovery/heuristics.js';
import { ScriptedLlmProvider } from '../../src/runtime/recovery/llm/scripted.js';
import { RecoveryFailedError, recover } from '../../src/runtime/recovery/recover.js';
import { buildFakeSite } from '../support/fake-site.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const CDP_URL = process.env['SNOOPIT_TEST_CDP_URL'] ?? 'http://127.0.0.1:9222';

let server: FixtureServer;
let hasChrome = false;

beforeAll(async () => {
  server = await startFixtureServer();
  try {
    const probe = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    hasChrome = probe.ok;
  } catch {
    hasChrome = false;
  }
});

afterAll(async () => {
  await server.close();
});

interface Harness {
  readonly name: string;
  readonly isReal: boolean;
  create(): Promise<BrowserBackend>;
}

const HARNESSES: Harness[] = [
  {
    name: 'FakeBackend',
    isReal: false,
    create: () => Promise.resolve(new FakeBackend(buildFakeSite(server.origin))),
  },
  {
    name: 'CdpBackend',
    isReal: true,
    create: () => CdpBackend.connect({ cdpUrl: CDP_URL, defaultTimeoutMs: 10_000 }),
  },
];

const PUBLICATIONS = { selector: '.publication-list' };

for (const harness of HARNESSES) {
  describe(`recovery (${harness.name})`, () => {
    let backend: BrowserBackend;
    const runs = (): boolean => !harness.isReal || hasChrome;

    beforeAll(async () => {
      if (!runs()) return;
      backend = await harness.create();
    });
    afterAll(async () => {
      if (!runs()) return;
      await backend.close();
    });

    it('clears a blocking modal at L1, with the model never consulted', async () => {
      if (!runs()) return;
      const llm = new ScriptedLlmProvider([{ text: 'should never be called' }]);
      const page = await backend.open(server.url('/gated.html'));

      // The content exists but is hidden behind the modal.
      expect(await page.query('.publication-list')).not.toBeNull();

      const outcome = await recover(
        page,
        { goal: 'Accéder à la liste des publications', expectedState: PUBLICATIONS },
        { llm },
      );

      expect(outcome.recovered).toBe(true);
      expect(outcome.level).toBe('L1');
      // The point of the whole design: no model call on an everyday obstacle.
      expect(outcome.llmCalls).toBe(0);
      expect(llm.callCount).toBe(0);
      expect(outcome.steps[0]).toMatchObject({
        level: 'L1',
        action: 'close_overlay',
        applied: true,
      });

      await page.close();
    });

    it('works with no provider at all', async () => {
      if (!runs()) return;
      const page = await backend.open(server.url('/gated.html'));
      const outcome = await recover(page, {
        goal: 'Accéder aux publications',
        expectedState: PUBLICATIONS,
      });
      expect(outcome.recovered).toBe(true);
      expect(outcome.level).toBe('L1');
      await page.close();
    });

    it('is a no-op when the page is already in the expected state', async () => {
      if (!runs()) return;
      const llm = new ScriptedLlmProvider([]);
      const page = await backend.open(server.url('/index.html'));

      const outcome = await recover(
        page,
        { goal: 'Voir les publications', expectedState: PUBLICATIONS },
        { llm },
      );

      // Guarding an action with recover() must cost nothing on the nominal path.
      expect(outcome).toMatchObject({ recovered: true, level: null, llmCalls: 0 });
      expect(outcome.steps).toEqual([]);
      await page.close();
    });

    it('never touches a login control while dismissing an overlay', async () => {
      if (!runs()) return;
      const page = await backend.open(server.url('/gated.html'));
      const result = await dismissOverlays(page);

      const clicked = result.dismissed.map((candidate) => candidate.selector);
      expect(clicked).not.toContain('#modal-signin');
      expect(clicked).toContain('#confirm-age');
      await page.close();
    });

    it('stops on a human-verification challenge instead of escalating', async () => {
      if (!runs()) return;
      const llm = new ScriptedLlmProvider([{ text: '{"action":"click","selector":"#solve"}' }]);
      const page = await backend.open(server.url('/challenged.html'));

      const error = await recover(
        page,
        { goal: 'Accéder aux publications', expectedState: PUBLICATIONS },
        { llm },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BlockedError);
      expect((error as BlockedError).signal.reason).toBe('captcha');
      // Asking a model to get past a challenge is the behaviour we refuse.
      expect(llm.callCount).toBe(0);
      await page.close();
    });

    it('fails explicitly at L4 when nothing works', async () => {
      if (!runs()) return;
      const llm = new ScriptedLlmProvider([
        { text: '{"action":"give_up","reason":"nothing here leads to the goal"}' },
        { text: '{"action":"give_up","reason":"nothing here leads to the goal"}' },
      ]);
      const page = await backend.open(server.url('/index.html'));

      const error = await recover(
        page,
        { goal: 'Trouver une chose absente', expectedState: { selector: '.absent-forever' } },
        { llm },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RecoveryFailedError);
      const failure = error as RecoveryFailedError;
      expect(failure.outcome.recovered).toBe(false);
      expect(failure.outcome.steps.some((step) => step.action === 'give_up')).toBe(true);
      await page.close();
    });
  });
}

describe('recovery guardrails (FakeBackend)', () => {
  const site = (): FakeBackend => new FakeBackend(buildFakeSite(server.origin));

  it('refuses a selector the model was not offered', async () => {
    // The model chooses among what we showed it; it cannot conjure a selector for
    // something hidden, which is the whole point of offering a filtered list.
    const llm = new ScriptedLlmProvider([
      { text: '{"action":"click","selector":"#invented","reason":"guessing"}' },
      { text: '{"action":"give_up","reason":"done guessing"}' },
    ]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    const error = await recover(
      page,
      { goal: 'Atteindre une chose absente', expectedState: { selector: '.absent' }, maxSteps: 2 },
      { llm },
    ).catch((e: unknown) => e);

    const failure = error as RecoveryFailedError;
    expect(
      failure.outcome.steps.some(
        (step) => step.target === '#invented' && !step.applied && step.reason.includes('offered'),
      ),
    ).toBe(true);
    await backend.close();
  });

  it('refuses an action the workflow did not allow', async () => {
    const llm = new ScriptedLlmProvider([
      { text: '{"action":"click","selector":"#real-button","reason":"try it"}' },
      { text: '{"action":"give_up","reason":"no other option"}' },
    ]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    const error = await recover(
      page,
      {
        goal: 'Atteindre une chose absente',
        expectedState: { selector: '.absent' },
        allowedActions: ['scroll'],
        maxSteps: 2,
      },
      { llm },
    ).catch((e: unknown) => e);

    const failure = error as RecoveryFailedError;
    expect(failure.outcome.steps.some((step) => step.reason.includes('not allowed'))).toBe(true);
    await backend.close();
  });

  it('treats a malformed reply as a failed step, not a crash', async () => {
    const llm = new ScriptedLlmProvider([
      { text: 'I think you should click the button.' },
      { text: '{"action":"give_up","reason":"giving up"}' },
      { text: '{"action":"give_up","reason":"giving up"}' },
    ]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    const error = await recover(
      page,
      { goal: 'Atteindre une chose absente', expectedState: { selector: '.absent' }, maxSteps: 2 },
      { llm },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RecoveryFailedError);
    expect(
      (error as RecoveryFailedError).outcome.steps.some((step) => step.action === 'invalid-reply'),
    ).toBe(true);
    await backend.close();
  });

  it('stops at the level the caller allows', async () => {
    const llm = new ScriptedLlmProvider([{ text: '{"action":"give_up","reason":"x"}' }]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    const error = await recover(
      page,
      {
        goal: 'Atteindre une chose absente',
        expectedState: { selector: '.absent' },
        maxLevel: 'L1',
      },
      { llm },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RecoveryFailedError);
    expect(llm.callCount).toBe(0);
    await backend.close();
  });

  it('sends a screenshot only at L3', async () => {
    const llm = new ScriptedLlmProvider([
      { text: '{"action":"give_up","reason":"L2 gives up"}' },
      { text: '{"action":"give_up","reason":"L3 gives up"}' },
    ]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    await recover(
      page,
      { goal: 'Atteindre une chose absente', expectedState: { selector: '.absent' }, maxSteps: 1 },
      { llm },
    ).catch(() => undefined);

    expect(llm.callCount).toBe(2);
    const [l2, l3] = llm.requests;
    // L2 is text only; the expensive multimodal call is the last resort.
    expect(typeof l2!.messages[1]!.content).toBe('string');
    expect(Array.isArray(l3!.messages[1]!.content)).toBe(true);
    const parts = l3!.messages[1]!.content as readonly { type: string }[];
    expect(parts.some((part) => part.type === 'image')).toBe(true);
    await backend.close();
  });

  it('skips L3 with a text-only provider', async () => {
    const llm = new ScriptedLlmProvider([{ text: '{"action":"give_up","reason":"x"}' }], false);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    await recover(
      page,
      { goal: 'Atteindre une chose absente', expectedState: { selector: '.absent' }, maxSteps: 1 },
      { llm },
    ).catch(() => undefined);

    expect(llm.callCount).toBe(1);
    await backend.close();
  });

  it('stops the moment the LLM budget refuses another call', async () => {
    const llm = new ScriptedLlmProvider([{ text: '{"action":"give_up","reason":"x"}' }]);
    const backend = site();
    const page = await backend.open(server.url('/index.html'));

    const error = await recover(
      page,
      { goal: 'Atteindre une chose absente', expectedState: { selector: '.absent' } },
      {
        llm,
        onLlmCall: () => {
          throw new Error('LLM budget spent');
        },
      },
    ).catch((e: unknown) => e);

    // The budget is consulted before the call, so nothing is spent.
    expect((error as Error).message).toBe('LLM budget spent');
    expect(llm.callCount).toBe(0);
    await backend.close();
  });
});
