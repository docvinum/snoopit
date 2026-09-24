import { describe, expect, it } from 'vitest';
import { siteHost } from '../../src/runtime/navigation/canonical.js';
import { detectLoginWall } from '../../src/runtime/navigation/session.js';

describe('siteHost', () => {
  it('treats www and the bare domain as one site', () => {
    expect(siteHost('https://www.leboncoin.fr/my-searches')).toBe('leboncoin.fr');
    expect(siteHost('https://leboncoin.fr/')).toBe('leboncoin.fr');
  });

  it('keeps other subdomains distinct: a login host is another place', () => {
    expect(siteHost('https://auth.leboncoin.fr/login/')).toBe('auth.leboncoin.fr');
  });

  it('ignores case and port, and returns null for garbage', () => {
    expect(siteHost('HTTP://WWW.Example.COM:8080/x')).toBe('example.com');
    expect(siteHost('not a url')).toBeNull();
  });
});

describe('detectLoginWall', () => {
  const expectation = { expectHost: 'www.leboncoin.fr' };

  it('says nothing while the visit ends where a logged-in one does', () => {
    expect(
      detectLoginWall({
        finalUrl: 'https://www.leboncoin.fr/my-searches',
        expectation,
        loginSelectorPresent: false,
      }),
    ).toBeNull();
  });

  it('names the redirect when the visit ends on the login host', () => {
    const evidence = detectLoginWall({
      finalUrl: 'https://auth.leboncoin.fr/login/?from_to=https://www.leboncoin.fr/my-searches',
      expectation,
      loginSelectorPresent: false,
    });
    expect(evidence).toBe('redirected to auth.leboncoin.fr, expected www.leboncoin.fr');
  });

  it('names the selector when a login wall is rendered in place', () => {
    expect(
      detectLoginWall({
        finalUrl: 'https://www.leboncoin.fr/my-searches',
        expectation: { loginSelector: '#login' },
        loginSelectorPresent: true,
      }),
    ).toBe('login wall present: #login');
  });

  it('expects nothing when the workflow declared nothing', () => {
    expect(
      detectLoginWall({ finalUrl: 'https://x.test/', expectation: {}, loginSelectorPresent: true }),
    ).toBeNull();
  });
});
