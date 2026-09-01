import { describe, expect, it } from 'vitest';
import {
  applyCanonicalLink,
  canonicalizeUrl,
  canonicalizeUrlOrThrow,
  isSameOrigin,
  originOf,
  tryCanonicalizeUrl,
} from '../../src/runtime/navigation/canonical.js';

/** Convenience: canonicalise and fail the test if the URL was rejected. */
function canon(input: string, options = {}): string {
  const result = canonicalizeUrl(input, options);
  expect(result, `expected ${input} to canonicalise`).toMatchObject({ ok: true });
  return (result as { ok: true; canonical: string }).canonical;
}

describe('canonicalizeUrl — normalisation', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(canon('HTTP://Example.COM/Path/To/Page')).toBe('http://example.com/Path/To/Page');
  });

  it('drops default ports and keeps non-default ones', () => {
    expect(canon('http://example.com:80/a')).toBe('http://example.com/a');
    expect(canon('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canon('http://example.com:8080/a')).toBe('http://example.com:8080/a');
  });

  it('removes the fragment', () => {
    expect(canon('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('strips embedded credentials', () => {
    expect(canon('https://user:pass@example.com/a')).toBe('https://example.com/a');
  });

  it('resolves dot segments', () => {
    expect(canon('https://example.com/a/b/../c')).toBe('https://example.com/a/c');
  });

  it('normalises the root path', () => {
    expect(canon('https://example.com')).toBe('https://example.com/');
    expect(canon('https://example.com/')).toBe('https://example.com/');
  });
});

describe('canonicalizeUrl — query parameters', () => {
  it('sorts parameters so order does not create a second identity', () => {
    expect(canon('https://example.com/a?b=2&a=1')).toBe(canon('https://example.com/a?a=1&b=2'));
    expect(canon('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });

  it('orders repeated keys deterministically by value', () => {
    expect(canon('https://example.com/a?tag=z&tag=a')).toBe('https://example.com/a?tag=a&tag=z');
  });

  it('removes known tracking parameters', () => {
    expect(canon('https://example.com/a?utm_source=x&utm_campaign=y&id=7')).toBe(
      'https://example.com/a?id=7',
    );
    expect(canon('https://example.com/a?fbclid=abc&gclid=def&page=2')).toBe(
      'https://example.com/a?page=2',
    );
  });

  it('removes tracking parameters case-insensitively', () => {
    expect(canon('https://example.com/a?UTM_Source=x&FBCLID=y')).toBe('https://example.com/a');
  });

  it('drops the "?" entirely when nothing survives', () => {
    expect(canon('https://example.com/a?utm_source=x')).toBe('https://example.com/a');
    expect(canon('https://example.com/a?')).toBe('https://example.com/a');
  });

  it('keeps parameters that carry meaning', () => {
    expect(canon('https://example.com/search?q=wine&page=3')).toBe(
      'https://example.com/search?page=3&q=wine',
    );
  });

  it('honours extraTrackingParams and keepParams, with keepParams winning', () => {
    expect(canon('https://example.com/a?sid=1&b=2', { extraTrackingParams: ['sid'] })).toBe(
      'https://example.com/a?b=2',
    );
    expect(canon('https://example.com/a?utm_source=x', { keepParams: ['utm_source'] })).toBe(
      'https://example.com/a?utm_source=x',
    );
  });
});

describe('canonicalizeUrl — path shaping', () => {
  it('strips index filenames by default', () => {
    expect(canon('https://example.com/docs/index.html')).toBe('https://example.com/docs');
    expect(canon('https://example.com/index.php')).toBe('https://example.com/');
  });

  it('strips a trailing slash on non-root paths by default', () => {
    expect(canon('https://example.com/a/b/')).toBe('https://example.com/a/b');
  });

  it('can be told to keep both', () => {
    expect(canon('https://example.com/a/b/', { stripTrailingSlash: false })).toBe(
      'https://example.com/a/b/',
    );
    expect(canon('https://example.com/docs/index.html', { stripIndexFiles: false })).toBe(
      'https://example.com/docs/index.html',
    );
  });
});

describe('canonicalizeUrl — conservative merging', () => {
  it('keeps www and apex hosts distinct by default', () => {
    expect(canon('https://www.example.com/a')).not.toBe(canon('https://example.com/a'));
  });

  it('merges them only when explicitly asked', () => {
    expect(canon('https://www.example.com/a', { stripWww: true })).toBe('https://example.com/a');
  });

  it('keeps http and https distinct', () => {
    expect(canon('http://example.com/a')).not.toBe(canon('https://example.com/a'));
  });
});

describe('canonicalizeUrl — relative resolution', () => {
  it('resolves against a base URL', () => {
    expect(canon('../other', { base: 'https://example.com/a/b/page' })).toBe(
      'https://example.com/a/other',
    );
    expect(canon('/root', { base: 'https://example.com/a/b' })).toBe('https://example.com/root');
    expect(canon('?page=2', { base: 'https://example.com/list' })).toBe(
      'https://example.com/list?page=2',
    );
  });
});

describe('canonicalizeUrl — rejections', () => {
  it.each([
    ['', 'empty'],
    ['#', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'invalid-url'],
    ['javascript:alert(1)', 'unsupported-scheme'],
    ['mailto:a@b.com', 'unsupported-scheme'],
    ['ftp://example.com/f', 'unsupported-scheme'],
    ['data:text/html,hi', 'unsupported-scheme'],
  ])('rejects %j as %s', (input, reason) => {
    const result = canonicalizeUrl(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.reason).toBe(reason);
  });

  it('tryCanonicalizeUrl returns null instead of a reason', () => {
    expect(tryCanonicalizeUrl('javascript:void(0)')).toBeNull();
    expect(tryCanonicalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('canonicalizeUrlOrThrow throws with the input in the message', () => {
    expect(() => canonicalizeUrlOrThrow('nope')).toThrow(/nope/);
  });
});

describe('canonicalizeUrl — idempotence', () => {
  it.each([
    'HTTP://Example.com:80/a/b/../c/index.html?utm_source=x&b=2&a=1#frag',
    'https://example.com',
    'https://example.com/a/b/',
    'https://example.com/search?q=%C3%A9t%C3%A9',
  ])('canonicalising twice is the same as once: %s', (input) => {
    const once = canon(input);
    expect(canon(once)).toBe(once);
  });
});

describe('origins', () => {
  it('reports the origin, or null for garbage', () => {
    expect(originOf('https://example.com:443/a')).toBe('https://example.com');
    expect(originOf('http://example.com:8080/a')).toBe('http://example.com:8080');
    expect(originOf('not a url')).toBeNull();
  });

  it('compares origins', () => {
    expect(isSameOrigin('https://example.com/a', 'https://example.com/b')).toBe(true);
    expect(isSameOrigin('https://example.com/a', 'http://example.com/a')).toBe(false);
    expect(isSameOrigin('https://example.com/a', 'https://other.com/a')).toBe(false);
    expect(isSameOrigin('garbage', 'https://example.com')).toBe(false);
  });
});

describe('applyCanonicalLink', () => {
  it('uses the declared canonical when it is same-origin', () => {
    const result = applyCanonicalLink(
      'https://example.com/article?utm_source=news',
      'https://example.com/article',
    );
    expect(result).toMatchObject({ ok: true, canonical: 'https://example.com/article' });
  });

  it('resolves a relative canonical link against the page URL', () => {
    const result = applyCanonicalLink('https://example.com/a/b/page', '../canonical');
    expect(result).toMatchObject({ ok: true, canonical: 'https://example.com/a/canonical' });
  });

  it('ignores a cross-origin canonical link', () => {
    // Honouring this would let any page reassign its identity to another host.
    const result = applyCanonicalLink('https://example.com/a', 'https://evil.com/a');
    expect(result).toMatchObject({ ok: true, canonical: 'https://example.com/a' });
  });

  it('falls back to the page URL when the link is absent or unusable', () => {
    for (const declared of [null, undefined, '', '   ', 'javascript:void(0)']) {
      expect(applyCanonicalLink('https://example.com/a', declared)).toMatchObject({
        ok: true,
        canonical: 'https://example.com/a',
      });
    }
  });

  it('propagates a failure when the page URL itself is unusable', () => {
    expect(applyCanonicalLink('mailto:a@b.com', null).ok).toBe(false);
  });
});
