/**
 * Recognising that a site has told us to stop.
 *
 * When a site answers with a CAPTCHA, a systematic 403, or an explicit rate limit,
 * the correct behaviour is `STOP` + journalisation + rapport (spec §12). This module
 * exists to *recognise* that answer so the run can end honestly.
 *
 * It is deliberately one-way. Nothing here solves a challenge, retries around a
 * block, rotates an identity, or hides a pattern — and no such thing belongs here.
 * Detection escalates to a clean stop, never to the LLM: asking a model to get past
 * a CAPTCHA is precisely the behaviour this project refuses.
 *
 * The classifier is pure, so the whole policy is visible in one file and testable
 * without a network.
 */

/** Why we believe the site is refusing us. */
export type BlockReason = 'captcha' | 'http-forbidden' | 'rate-limited' | 'access-denied-page';

export interface BlockSignal {
  readonly reason: BlockReason;
  /** What was observed, in words, for the run report. */
  readonly evidence: string;
}

export interface BlockingInput {
  readonly url: string;
  readonly status: number | null;
  /** Response headers, lowercased keys. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Visible page text. Whitespace-normalised; matching is case-insensitive. */
  readonly text?: string;
  /** Selectors present on the page, e.g. from `queryAll`. */
  readonly selectorsPresent?: readonly string[];
}

/**
 * Markers of a challenge widget.
 *
 * Presence of one of these means a human verification step is being demanded. We
 * report it and stop; we never interact with it.
 */
const CAPTCHA_SELECTORS: readonly string[] = [
  '.g-recaptcha',
  '#recaptcha',
  'iframe[src*="recaptcha"]',
  '.h-captcha',
  'iframe[src*="hcaptcha"]',
  '#cf-challenge-running',
  '#challenge-form',
  '[data-cf-challenge]',
  '.cf-turnstile',
  // DataDome, served by leboncoin among others: the challenge frame once rendered,
  // and the script of its bare interstitial ("Please enable JS…") before it is.
  'iframe[src*="captcha-delivery.com"]',
  'script[src*="captcha-delivery.com"]',
];

/** Phrases that name a challenge, in the languages our fixtures and targets use. */
const CAPTCHA_PHRASES: readonly string[] = [
  'captcha',
  'not a robot',
  'vérifiez que vous êtes humain',
  "vérifiez que vous n'êtes pas un robot",
  'verifying you are human',
  'checking your browser',
  'unusual traffic',
  'trafic inhabituel',
];

const ACCESS_DENIED_PHRASES: readonly string[] = [
  'access denied',
  'accès refusé',
  'you have been blocked',
  'vous avez été bloqué',
  'forbidden',
];

const RATE_LIMIT_PHRASES: readonly string[] = [
  'too many requests',
  'trop de requêtes',
  'rate limit',
  'slow down',
];

function containsAny(haystack: string, needles: readonly string[]): string | null {
  return needles.find((needle) => haystack.includes(needle)) ?? null;
}

/**
 * Decides whether the site is refusing us, and why.
 *
 * Ordered by how unambiguous the signal is: a challenge widget is the clearest, a
 * status code next, page wording last — wording is the weakest evidence and is only
 * consulted when it is unambiguous.
 *
 * @returns the signal, or `null` when nothing indicates a block.
 */
export function detectBlocking(input: BlockingInput): BlockSignal | null {
  const text = (input.text ?? '').toLowerCase();
  const present = new Set(input.selectorsPresent ?? []);

  const captchaSelector = CAPTCHA_SELECTORS.find((selector) => present.has(selector));
  if (captchaSelector !== undefined) {
    return { reason: 'captcha', evidence: `challenge widget present: ${captchaSelector}` };
  }

  const captchaPhrase = containsAny(text, CAPTCHA_PHRASES);
  if (captchaPhrase !== null) {
    return { reason: 'captcha', evidence: `page text mentions "${captchaPhrase}"` };
  }

  if (input.status === 429) {
    const retryAfter = input.headers?.['retry-after'];
    return {
      reason: 'rate-limited',
      evidence: retryAfter === undefined ? 'HTTP 429' : `HTTP 429, Retry-After: ${retryAfter}`,
    };
  }

  if (input.status === 403) {
    return { reason: 'http-forbidden', evidence: 'HTTP 403' };
  }

  const ratePhrase = containsAny(text, RATE_LIMIT_PHRASES);
  if (ratePhrase !== null) {
    return { reason: 'rate-limited', evidence: `page text mentions "${ratePhrase}"` };
  }

  const deniedPhrase = containsAny(text, ACCESS_DENIED_PHRASES);
  if (deniedPhrase !== null) {
    return { reason: 'access-denied-page', evidence: `page text mentions "${deniedPhrase}"` };
  }

  return null;
}

/**
 * Thrown when a site has told us to stop.
 *
 * Handled by the runner as a clean, explicit end to the run — reported, not retried
 * and not worked around.
 */
export class BlockedError extends Error {
  constructor(
    readonly url: string,
    readonly signal: BlockSignal,
  ) {
    super(`Blocked at ${url}: ${signal.reason} (${signal.evidence})`);
    this.name = 'BlockedError';
  }
}

/** Selectors worth probing for on a page before deciding it is not blocked. */
export const BLOCKING_PROBE_SELECTORS: readonly string[] = CAPTCHA_SELECTORS;
