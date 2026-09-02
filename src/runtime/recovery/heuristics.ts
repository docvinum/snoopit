/**
 * L1 — deterministic overlay handling.
 *
 * Cookie banners, consent modals, newsletter popups and soft login walls are the
 * overwhelmingly common reason a script finds the page it expected hidden behind
 * something. They are also entirely predictable, which is why they must never reach
 * the LLM: spending a model call on "click Accept" is the pattern this project was
 * built to avoid.
 *
 * The classification is pure — it takes element snapshots and returns candidates —
 * so the rules are visible in one place and testable without a browser. Only the
 * clicking goes through the port.
 */

import type { ElementSnapshot, PageHandle } from '../browser/types.js';
import { isHumanInteractable } from '../browser/interactable.js';

export type OverlayKind = 'cookie-banner' | 'modal' | 'newsletter' | 'login-wall' | 'unknown';

export interface DismissCandidate {
  /** Selector of the control to click. */
  readonly selector: string;
  readonly kind: OverlayKind;
  /** Higher wins. Derived from how unambiguous the match is. */
  readonly score: number;
  /** Why this control was chosen, for the run report. */
  readonly reason: string;
}

/**
 * Containers that usually *are* an overlay.
 *
 * Matching a container is not enough to click anything — it only tells us where to
 * look for a dismissal control.
 */
export const OVERLAY_CONTAINER_SELECTORS: readonly string[] = [
  '#cookie-banner',
  '.cookie-banner',
  '#cookieConsent',
  '#onetrust-banner-sdk',
  '#didomi-popup',
  '#tarteaucitronRoot',
  '[id*="cookie" i][class*="banner" i]',
  '[aria-label*="cookie" i]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.modal',
  '.overlay',
  '.popup',
  '[data-testid*="modal" i]',
];

/**
 * Controls that dismiss an overlay, most specific first.
 *
 * Consent-first: an "accept" control is preferred over a bare close button, because
 * on a consent banner the close button often means "reject and keep the banner".
 */
const DISMISS_SELECTORS: readonly { selector: string; kind: OverlayKind; score: number }[] = [
  { selector: '#accept-cookies', kind: 'cookie-banner', score: 100 },
  { selector: '#onetrust-accept-btn-handler', kind: 'cookie-banner', score: 100 },
  { selector: '#didomi-notice-agree-button', kind: 'cookie-banner', score: 100 },
  { selector: '#tarteaucitronAllAllowed', kind: 'cookie-banner', score: 100 },
  { selector: '[aria-label*="accepter" i]', kind: 'cookie-banner', score: 80 },
  { selector: '[aria-label*="accept" i]', kind: 'cookie-banner', score: 80 },
  { selector: '[data-testid*="accept" i]', kind: 'cookie-banner', score: 80 },
  { selector: '[aria-label*="fermer" i]', kind: 'modal', score: 60 },
  { selector: '[aria-label*="close" i]', kind: 'modal', score: 60 },
  { selector: '[aria-label*="dismiss" i]', kind: 'modal', score: 60 },
  { selector: 'button.close', kind: 'modal', score: 50 },
  { selector: '.modal-close', kind: 'modal', score: 50 },
];

/** Button wording that dismisses, by overlay kind. Matched on normalised text. */
const DISMISS_PHRASES: readonly { phrase: string; kind: OverlayKind; score: number }[] = [
  { phrase: 'tout accepter', kind: 'cookie-banner', score: 95 },
  { phrase: 'accepter tout', kind: 'cookie-banner', score: 95 },
  { phrase: 'accept all', kind: 'cookie-banner', score: 95 },
  { phrase: "j'accepte", kind: 'cookie-banner', score: 90 },
  { phrase: 'accepter', kind: 'cookie-banner', score: 85 },
  { phrase: 'accept', kind: 'cookie-banner', score: 85 },
  { phrase: 'i agree', kind: 'cookie-banner', score: 85 },
  { phrase: 'continuer sans accepter', kind: 'cookie-banner', score: 70 },
  { phrase: 'continue without accepting', kind: 'cookie-banner', score: 70 },
  { phrase: 'non merci', kind: 'newsletter', score: 65 },
  { phrase: 'no thanks', kind: 'newsletter', score: 65 },
  { phrase: 'plus tard', kind: 'newsletter', score: 60 },
  { phrase: 'maybe later', kind: 'newsletter', score: 60 },
  { phrase: 'fermer', kind: 'modal', score: 55 },
  { phrase: 'close', kind: 'modal', score: 55 },
  { phrase: 'continuer', kind: 'modal', score: 40 },
  { phrase: 'continue', kind: 'modal', score: 40 },
  { phrase: "j'ai compris", kind: 'modal', score: 50 },
  { phrase: 'got it', kind: 'modal', score: 50 },
  { phrase: 'ok', kind: 'modal', score: 30 },
];

/**
 * Wording that must never be clicked, whatever else matches.
 *
 * These either commit us to something (paying, subscribing, signing in) or reject
 * consent in a way that leaves the overlay standing. A workflow that genuinely needs
 * to log in does so in its own script, deliberately — never as a side effect of a
 * heuristic.
 */
const NEVER_CLICK_PHRASES: readonly string[] = [
  'se connecter',
  'connexion',
  'sign in',
  'log in',
  'login',
  "s'inscrire",
  'sign up',
  'register',
  'créer un compte',
  'create account',
  "s'abonner",
  'subscribe',
  'payer',
  'pay',
  'acheter',
  'buy',
  'supprimer',
  'delete',
  'paramétrer',
  'personnaliser',
  'manage preferences',
  'gérer mes choix',
];

function isForbidden(text: string): boolean {
  const normalised = text.trim().toLowerCase();
  return NEVER_CLICK_PHRASES.some((phrase) => normalised.includes(phrase));
}

export interface ClassifyInput {
  /** Clickable elements on the page, with their snapshots. */
  readonly controls: readonly ElementSnapshot[];
  /** Selectors of overlay containers found on the page. */
  readonly overlayContainers: readonly string[];
}

/**
 * Ranks the controls that would plausibly dismiss an overlay.
 *
 * Pure. Returns candidates best-first; an empty list means "nothing here looks like
 * an overlay dismissal", which is a perfectly ordinary answer.
 */
export function classifyDismissCandidates(input: ClassifyInput): DismissCandidate[] {
  const hasOverlay = input.overlayContainers.length > 0;
  const candidates: DismissCandidate[] = [];

  for (const control of input.controls) {
    // Only ever act on what a person could act on. This is also what stops the
    // heuristic from "helpfully" clicking something the interface does not offer.
    if (!isHumanInteractable(control.view).interactable) continue;
    if (isForbidden(control.text)) continue;

    const selectorMatch = DISMISS_SELECTORS.find((rule) => rule.selector === control.selector);
    if (selectorMatch !== undefined) {
      candidates.push({
        selector: control.selector,
        kind: selectorMatch.kind,
        score: selectorMatch.score,
        reason: `control matches known dismissal selector ${selectorMatch.selector}`,
      });
      continue;
    }

    const normalised = control.text.trim().toLowerCase();
    const phraseMatch = DISMISS_PHRASES.find((rule) => normalised === rule.phrase);
    if (phraseMatch !== undefined) {
      candidates.push({
        selector: control.selector,
        kind: phraseMatch.kind,
        // Wording is weaker evidence when no overlay container was found at all.
        score: phraseMatch.score - (hasOverlay ? 0 : 25),
        reason: `control labelled "${control.text}"`,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export interface DismissResult {
  /** Candidates that were clicked, in order. */
  readonly dismissed: readonly DismissCandidate[];
  /** Overlay containers still present afterwards. */
  readonly remaining: readonly string[];
}

/** Builds a stable selector for a snapshot, preferring an id. */
function selectorFor(snapshot: ElementSnapshot, index: number): string {
  const id = snapshot.attributes['id'];
  if (id !== undefined && id !== '') return `#${id}`;
  return `${snapshot.tagName}:nth-of-type(${String(index + 1)})`;
}

/** Collects the page's clickable controls, each with a usable selector. */
export async function collectControls(page: PageHandle): Promise<ElementSnapshot[]> {
  const raw = await page.queryAll(
    'button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]',
  );
  return raw.map((snapshot, index) => ({ ...snapshot, selector: selectorFor(snapshot, index) }));
}

/** Overlay containers currently present on the page. */
export async function findOverlayContainers(page: PageHandle): Promise<string[]> {
  const found: string[] = [];
  for (const selector of OVERLAY_CONTAINER_SELECTORS) {
    const element = await page.query(selector);
    if (element !== null && isHumanInteractable(element.view).interactable) {
      found.push(selector);
    }
  }
  return found;
}

export interface DismissOptions {
  /** Most controls to click in one pass. Overlays occasionally stack. */
  readonly maxClicks?: number;
  readonly timeoutMs?: number;
}

/**
 * Dismisses the overlays it recognises, deterministically and without an LLM.
 *
 * Returns what it clicked so the run report can say exactly what was done to the
 * page — a dismissal that happens silently is indistinguishable from a site that
 * behaved differently today.
 */
export async function dismissOverlays(
  page: PageHandle,
  options: DismissOptions = {},
): Promise<DismissResult> {
  const maxClicks = options.maxClicks ?? 3;
  const dismissed: DismissCandidate[] = [];

  for (let pass = 0; pass < maxClicks; pass += 1) {
    const overlayContainers = await findOverlayContainers(page);
    if (overlayContainers.length === 0) break;

    const controls = await collectControls(page);
    const candidates = classifyDismissCandidates({ controls, overlayContainers }).filter(
      (candidate) => !dismissed.some((done) => done.selector === candidate.selector),
    );

    const best = candidates[0];
    if (best === undefined) break;

    try {
      await page.click(best.selector, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      dismissed.push(best);
    } catch {
      // A control that refuses to be clicked is not a failure of the run: it simply
      // was not the dismissal we took it for. Stop rather than flail.
      break;
    }
  }

  return { dismissed, remaining: await findOverlayContainers(page) };
}
