import { describe, expect, it } from 'vitest';
import { classifyDismissCandidates } from '../../src/runtime/recovery/heuristics.js';
import { VISIBLE_ELEMENT_VIEW } from '../../src/runtime/browser/interactable.js';
import type { ElementSnapshot } from '../../src/runtime/browser/types.js';

function control(
  selector: string,
  text: string,
  overrides: Partial<ElementSnapshot> = {},
): ElementSnapshot {
  return {
    selector,
    tagName: 'button',
    text,
    html: text,
    attributes: {},
    view: VISIBLE_ELEMENT_VIEW,
    ...overrides,
  };
}

const withOverlay = { overlayContainers: ['#cookie-banner'] };

describe('classifyDismissCandidates', () => {
  it('finds nothing on a page with no dismissal control', () => {
    expect(
      classifyDismissCandidates({
        controls: [control('#search', 'Rechercher'), control('#more', 'Voir plus')],
        ...withOverlay,
      }),
    ).toEqual([]);
  });

  it('recognises a known consent selector', () => {
    const [best] = classifyDismissCandidates({
      controls: [control('#accept-cookies', 'Accepter')],
      ...withOverlay,
    });
    expect(best?.selector).toBe('#accept-cookies');
    expect(best?.kind).toBe('cookie-banner');
  });

  it.each([
    ['Tout accepter', 'cookie-banner'],
    ["J'accepte", 'cookie-banner'],
    ['Accept all', 'cookie-banner'],
    ['Non merci', 'newsletter'],
    ['Fermer', 'modal'],
    ["J'ai compris", 'modal'],
  ])('recognises the label %j as %s', (text, kind) => {
    const [best] = classifyDismissCandidates({
      controls: [control('#btn', text)],
      ...withOverlay,
    });
    expect(best?.kind).toBe(kind);
  });

  it('prefers accepting consent over merely closing the banner', () => {
    // On a consent banner a bare close button often means "reject and keep it".
    const candidates = classifyDismissCandidates({
      controls: [control('#close', 'Fermer'), control('#ok', 'Tout accepter')],
      ...withOverlay,
    });
    expect(candidates[0]?.selector).toBe('#ok');
  });

  it.each(['Se connecter', 'Sign in', "S'inscrire", "S'abonner", 'Payer', 'Gérer mes choix'])(
    'never proposes %j',
    (text) => {
      // These commit us to something, or leave the overlay standing.
      expect(
        classifyDismissCandidates({ controls: [control('#danger', text)], ...withOverlay }),
      ).toEqual([]);
    },
  );

  it('ignores a control a person could not operate', () => {
    const hidden = control('#accept-cookies', 'Accepter', {
      view: { ...VISIBLE_ELEMENT_VIEW, display: 'none' },
    });
    expect(classifyDismissCandidates({ controls: [hidden], ...withOverlay })).toEqual([]);
  });

  it('trusts wording less when no overlay container was found', () => {
    const controls = [control('#btn', 'Fermer')];
    const withContainer = classifyDismissCandidates({ controls, ...withOverlay })[0]!;
    const without = classifyDismissCandidates({ controls, overlayContainers: [] })[0]!;
    expect(without.score).toBeLessThan(withContainer.score);
  });

  it('still trusts a known selector without a container', () => {
    const candidates = classifyDismissCandidates({
      controls: [control('#onetrust-accept-btn-handler', 'Accept')],
      overlayContainers: [],
    });
    expect(candidates[0]?.score).toBe(100);
  });

  it('returns candidates best first', () => {
    const candidates = classifyDismissCandidates({
      controls: [control('#a', 'OK'), control('#b', 'Tout accepter'), control('#c', 'Fermer')],
      ...withOverlay,
    });
    expect(candidates.map((candidate) => candidate.selector)).toEqual(['#b', '#c', '#a']);
  });

  it('explains every candidate, for the run report', () => {
    const candidates = classifyDismissCandidates({
      controls: [control('#accept-cookies', 'Accepter')],
      ...withOverlay,
    });
    expect(candidates[0]?.reason).toBeTruthy();
  });

  it('matches a label exactly, not as a substring', () => {
    // "Accepter les conditions et payer" must not be read as "Accepter".
    expect(
      classifyDismissCandidates({
        controls: [control('#x', 'Accepter les conditions et payer')],
        ...withOverlay,
      }),
    ).toEqual([]);
  });
});
