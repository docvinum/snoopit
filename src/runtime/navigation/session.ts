/**
 * Recognising that a page needs a session we no longer have.
 *
 * snoopit never logs in on its own: the session lives in the persistent Chrome
 * profile, put there by a person. Sessions expire, and when one does the site
 * usually answers a members-only URL with a redirect to its login page. Recorded
 * naively, that login page becomes "the content" of the members-only URL — hashed,
 * flagged as changed, and reported as a successful visit. The run looks healthy and
 * collects nothing.
 *
 * A workflow declares what a logged-in visit looks like (`visit(url, { session })`)
 * and this module decides, purely, whether a navigation matches it. On a mismatch
 * the run stops with `auth-required`: the fix is a person logging in again, not a
 * retry and not an automated login.
 */

import { siteHost } from './canonical.js';

export interface SessionExpectation {
  /**
   * Host a logged-in visit ends on, e.g. `www.leboncoin.fr`. Ending anywhere else —
   * typically `auth.<site>` — means the session is gone. A leading `www.` is ignored.
   */
  readonly expectHost?: string;
  /** A selector only a login wall shows, for sites that render it in place. */
  readonly loginSelector?: string;
}

export interface SessionCheckInput {
  readonly finalUrl: string;
  readonly expectation: SessionExpectation;
  /** Whether `expectation.loginSelector` matched on the page. */
  readonly loginSelectorPresent: boolean;
}

/** Why we believe the session is gone, for the run report; `null` when it is not. */
export function detectLoginWall(input: SessionCheckInput): string | null {
  const { finalUrl, expectation } = input;

  if (expectation.expectHost !== undefined) {
    const expected = siteHost(`https://${expectation.expectHost}`);
    const actual = siteHost(finalUrl);
    if (actual !== expected) {
      return `redirected to ${actual ?? finalUrl}, expected ${expectation.expectHost}`;
    }
  }

  if (expectation.loginSelector !== undefined && input.loginSelectorPresent) {
    return `login wall present: ${expectation.loginSelector}`;
  }

  return null;
}

/**
 * Thrown when a page that needs a session landed on a login wall instead.
 *
 * Handled by the runner as a deliberate stop (`auth-required`), like a block: the
 * run ends, is reported, and waits for a person to restore the session.
 */
export class AuthRequiredError extends Error {
  constructor(
    readonly url: string,
    readonly finalUrl: string,
    readonly evidence: string,
  ) {
    super(`Session required at ${url}: ${evidence}`);
    this.name = 'AuthRequiredError';
  }
}
