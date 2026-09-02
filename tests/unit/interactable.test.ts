import { describe, expect, it } from 'vitest';
import {
  isHumanInteractable,
  VISIBLE_ELEMENT_VIEW,
  type ElementView,
} from '../../src/runtime/browser/interactable.js';

const view = (overrides: Partial<ElementView>): ElementView => ({
  ...VISIBLE_ELEMENT_VIEW,
  ...overrides,
});

describe('isHumanInteractable', () => {
  it('accepts an ordinary visible element', () => {
    expect(isHumanInteractable(VISIBLE_ELEMENT_VIEW)).toEqual({
      interactable: true,
      reasons: [],
    });
  });

  it.each<[string, Partial<ElementView>, string]>([
    ['display:none', { display: 'none' }, 'display-none'],
    ['visibility:hidden', { visibility: 'hidden' }, 'visibility-hidden'],
    ['visibility:collapse', { visibility: 'collapse' }, 'visibility-hidden'],
    ['the hidden attribute', { hidden: true }, 'hidden-attribute'],
    ['aria-hidden', { ariaHidden: true }, 'aria-hidden'],
    ['inert', { inert: true }, 'inert'],
    ['zero width', { width: 0 }, 'zero-size'],
    ['zero height', { height: 0 }, 'zero-size'],
    ['a 1x1 beacon', { width: 1, height: 1 }, 'zero-size'],
    ['full transparency', { opacity: 0 }, 'fully-transparent'],
    ['pointer-events:none', { pointerEvents: 'none' }, 'pointer-events-none'],
    ['being disabled', { disabled: true }, 'disabled'],
    ['being unreachable', { reachable: false }, 'unreachable'],
  ])('rejects %s', (_label, overrides, reason) => {
    const verdict = isHumanInteractable(view(overrides));
    expect(verdict.interactable).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });

  it('reports every failing rule, not just the first', () => {
    const verdict = isHumanInteractable(
      view({ display: 'none', ariaHidden: true, disabled: true }),
    );
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(['display-none', 'aria-hidden', 'disabled']),
    );
    expect(verdict.reasons).toHaveLength(3);
  });

  it('accepts content below the fold — that is ordinary interface, not hidden', () => {
    expect(isHumanInteractable(view({ reachable: true })).interactable).toBe(true);
  });

  it('accepts slight transparency, which is a visual effect rather than hiding', () => {
    expect(isHumanInteractable(view({ opacity: 0.6 })).interactable).toBe(true);
  });

  it('accepts a small but usable control', () => {
    expect(isHumanInteractable(view({ width: 16, height: 16 })).interactable).toBe(true);
  });

  it('produces reasons in a stable order, so they are safe to assert and log', () => {
    const first = isHumanInteractable(view({ display: 'none', disabled: true }));
    const second = isHumanInteractable(view({ display: 'none', disabled: true }));
    expect(first.reasons).toEqual(second.reasons);
  });
});
