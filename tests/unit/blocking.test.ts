import { describe, expect, it } from 'vitest';
import { detectBlocking } from '../../src/runtime/recovery/blocking.js';

const base = { url: 'https://example.com/list', status: 200 };

describe('detectBlocking — nothing wrong', () => {
  it('returns null for an ordinary page', () => {
    expect(detectBlocking({ ...base, text: 'Publications récentes du laboratoire' })).toBeNull();
  });

  it('returns null with no text and no markers at all', () => {
    expect(detectBlocking(base)).toBeNull();
  });

  it('does not mistake an ordinary 404 for a block', () => {
    // A missing page is a finding for the audit workflow, not a refusal.
    expect(detectBlocking({ ...base, status: 404, text: 'Page introuvable' })).toBeNull();
  });

  it('does not mistake a 500 for a block', () => {
    expect(detectBlocking({ ...base, status: 500, text: 'Erreur serveur' })).toBeNull();
  });
});

describe('detectBlocking — challenges', () => {
  it.each([
    '.g-recaptcha',
    '.h-captcha',
    'iframe[src*="recaptcha"]',
    '#cf-challenge-running',
    '.cf-turnstile',
  ])('recognises the %s widget', (selector) => {
    const signal = detectBlocking({ ...base, selectorsPresent: [selector] });
    expect(signal?.reason).toBe('captcha');
    expect(signal?.evidence).toContain(selector);
  });

  it.each([
    "Vérifiez que vous n'êtes pas un robot",
    'Please complete the CAPTCHA',
    'Checking your browser before accessing',
    'We detected unusual traffic from your network',
  ])('recognises challenge wording: %s', (text) => {
    expect(detectBlocking({ ...base, text })?.reason).toBe('captcha');
  });

  it('prefers the widget over wording, as the less ambiguous evidence', () => {
    const signal = detectBlocking({
      ...base,
      status: 403,
      text: 'access denied',
      selectorsPresent: ['.g-recaptcha'],
    });
    expect(signal?.reason).toBe('captcha');
  });
});

describe('detectBlocking — refusals', () => {
  it('reports a 429 as rate limiting, with Retry-After when given', () => {
    const signal = detectBlocking({
      ...base,
      status: 429,
      headers: { 'retry-after': '120' },
    });
    expect(signal?.reason).toBe('rate-limited');
    expect(signal?.evidence).toContain('120');
  });

  it('reports a 429 without the header too', () => {
    expect(detectBlocking({ ...base, status: 429 })?.reason).toBe('rate-limited');
  });

  it('recognises the DataDome interstitial by its challenge frame', () => {
    const signal = detectBlocking({
      ...base,
      selectorsPresent: ['iframe[src*="captcha-delivery.com"]'],
    });
    expect(signal?.reason).toBe('captcha');
  });

  it('reports a 403 as forbidden', () => {
    expect(detectBlocking({ ...base, status: 403 })?.reason).toBe('http-forbidden');
  });

  it('recognises an access-denied page served with a 200', () => {
    const signal = detectBlocking({ ...base, text: 'Access denied. You have been blocked.' });
    expect(signal?.reason).toBe('access-denied-page');
  });

  it('recognises rate-limit wording served with a 200', () => {
    expect(detectBlocking({ ...base, text: 'Too many requests, slow down' })?.reason).toBe(
      'rate-limited',
    );
  });

  it('matches wording case-insensitively', () => {
    expect(detectBlocking({ ...base, text: 'ACCESS DENIED' })?.reason).toBe('access-denied-page');
  });

  it('always explains itself, for the run report', () => {
    for (const input of [
      { ...base, status: 403 },
      { ...base, status: 429 },
      { ...base, selectorsPresent: ['.g-recaptcha'] },
      { ...base, text: 'access denied' },
    ]) {
      const signal = detectBlocking(input);
      expect(signal?.evidence).toBeTruthy();
    }
  });
});
