import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  BudgetGuard,
  effectiveBudget,
} from '../../src/runtime/budget/guard.js';

/** A controllable clock, so duration limits are tested without waiting. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe('BudgetGuard — no budget', () => {
  it('never blocks anything', () => {
    const guard = new BudgetGuard(null);
    guard.recordPage(1000);
    guard.recordBytes(1e12);
    guard.recordError(50);
    expect(guard.check('page')).toBeNull();
    expect(guard.ok('download')).toBe(true);
    expect(() => guard.assertOk('llm')).not.toThrow();
  });

  it('reports unlimited remaining as null', () => {
    expect(new BudgetGuard(null).remaining('max_pages')).toBeNull();
  });
});

describe('BudgetGuard — maxPages', () => {
  it('allows exactly the budgeted number of pages', () => {
    const guard = new BudgetGuard({ maxPages: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(guard.ok('page')).toBe(true);
      guard.recordPage();
    }
    // Ten pages means the eleventh is never started.
    expect(guard.ok('page')).toBe(false);
    expect(guard.check('page')).toBe('max_pages');
  });

  it('reports how many remain, so a frontier batch can be sized', () => {
    const guard = new BudgetGuard({ maxPages: 5 });
    expect(guard.remaining('max_pages')).toBe(5);
    guard.recordPage(2);
    expect(guard.remaining('max_pages')).toBe(3);
    guard.recordPage(10);
    expect(guard.remaining('max_pages')).toBe(0);
  });

  it('throws a typed error naming the limit and the numbers', () => {
    const guard = new BudgetGuard({ maxPages: 1 });
    guard.recordPage();
    try {
      guard.assertOk('page');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const budgetError = error as BudgetExceededError;
      expect(budgetError.limit).toBe('max_pages');
      expect(budgetError.used).toBe(1);
      expect(budgetError.max).toBe(1);
    }
  });
});

describe('BudgetGuard — limits are per operation', () => {
  it('does not let a zero LLM budget forbid page visits', () => {
    // `maxLlmCalls: 0` is the correct way to declare "this workflow uses no LLM".
    // Conflating limits would make that declaration forbid the first page visit.
    const guard = new BudgetGuard({ maxLlmCalls: 0, maxPages: 10 });
    expect(guard.ok('page')).toBe(true);
    expect(guard.ok('download')).toBe(true);
    expect(guard.ok('llm')).toBe(false);
    expect(guard.check('llm')).toBe('max_llm_calls');
  });

  it('does not let an exhausted byte budget forbid page visits', () => {
    const guard = new BudgetGuard({ maxDownloadBytes: 100, maxPages: 10 });
    guard.recordBytes(500);
    expect(guard.ok('download')).toBe(false);
    expect(guard.ok('page')).toBe(true);
  });

  it('applies duration and errors to every operation', () => {
    const clock = fakeClock();
    const guard = new BudgetGuard({ maxDuration: '1m', maxPages: 100 }, { now: clock.now });
    clock.advance(61_000);
    for (const operation of ['page', 'download', 'llm'] as const) {
      expect(guard.check(operation)).toBe('max_duration');
    }
  });

  it('blocks every operation once the error budget is spent', () => {
    const guard = new BudgetGuard({ maxErrors: 2, maxPages: 100 });
    guard.recordError(2);
    expect(guard.check('page')).toBe('max_errors');
    expect(guard.check('download')).toBe('max_errors');
  });

  it('checks only the global limits when no operation is named', () => {
    const guard = new BudgetGuard({ maxPages: 1, maxLlmCalls: 0 });
    guard.recordPage();
    expect(guard.check()).toBeNull();
  });
});

describe('BudgetGuard — duration', () => {
  it('allows work right up to the limit', () => {
    const clock = fakeClock();
    const guard = new BudgetGuard({ maxDuration: '20m' }, { now: clock.now });

    clock.advance(19 * 60_000);
    expect(guard.ok('page')).toBe(true);
    clock.advance(60_000);
    expect(guard.check('page')).toBe('max_duration');
  });

  it('parses composite durations', () => {
    const clock = fakeClock();
    const guard = new BudgetGuard({ maxDuration: '1h30m' }, { now: clock.now });
    clock.advance(89 * 60_000);
    expect(guard.ok('page')).toBe(true);
    clock.advance(2 * 60_000);
    expect(guard.ok('page')).toBe(false);
  });

  it('rejects an unparseable duration at construction, not mid-run', () => {
    expect(() => new BudgetGuard({ maxDuration: 'twenty minutes' })).toThrow();
  });
});

describe('BudgetGuard — usage', () => {
  it('reports what has been consumed', () => {
    const clock = fakeClock();
    const guard = new BudgetGuard({ maxPages: 10 }, { now: clock.now });
    guard.recordPage(3);
    guard.recordBytes(2048);
    guard.recordLlmCall();
    guard.recordError(2);
    clock.advance(5000);

    expect(guard.usage()).toEqual({
      pages: 3,
      downloadedBytes: 2048,
      llmCalls: 1,
      errors: 2,
      elapsedMs: 5000,
    });
  });
});

describe('effectiveBudget', () => {
  const defaults = { maxPages: 100, maxDuration: '20m', maxLlmCalls: 3, maxErrors: 10 };

  it('gives a workflow without a budget every default limit', () => {
    expect(effectiveBudget(null, defaults)).toEqual(defaults);
  });

  it('lets each limit a workflow names win, and inherits the others', () => {
    expect(effectiveBudget({ maxPages: 12, maxLlmCalls: 0 }, defaults)).toEqual({
      maxPages: 12,
      maxDuration: '20m',
      maxLlmCalls: 0,
      maxErrors: 10,
    });
  });

  it('keeps a limit only the workflow sets', () => {
    expect(effectiveBudget({ maxDownloadBytes: 5 }, { maxPages: 1 })).toEqual({
      maxPages: 1,
      maxDownloadBytes: 5,
    });
  });

  it('treats an explicitly undefined default as no default', () => {
    expect(effectiveBudget({ maxPages: 2 }, { maxPages: undefined, maxErrors: 1 })).toEqual({
      maxPages: 2,
      maxErrors: 1,
    });
  });

  it('stays unbounded only when there is nothing at all', () => {
    expect(effectiveBudget(null, null)).toBeNull();
    expect(effectiveBudget({ maxPages: 3 }, null)).toEqual({ maxPages: 3 });
  });
});
