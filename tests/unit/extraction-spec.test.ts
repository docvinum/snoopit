import { describe, expect, it } from 'vitest';
import {
  normalizeText,
  parseExtractSpec,
  parseFieldSpec,
} from '../../src/runtime/extraction/spec.js';

describe('parseFieldSpec', () => {
  it('treats a bare selector as a text field', () => {
    expect(parseFieldSpec('.title')).toEqual({ selector: '.title', attribute: 'text' });
  });

  it('splits selector and attribute', () => {
    expect(parseFieldSpec('a@href')).toEqual({ selector: 'a', attribute: 'href' });
    expect(parseFieldSpec('.body@html')).toEqual({ selector: '.body', attribute: 'html' });
  });

  it('treats a leading @ as an attribute of the item itself', () => {
    expect(parseFieldSpec('@data-id')).toEqual({ selector: null, attribute: 'data-id' });
    expect(parseFieldSpec('@text')).toEqual({ selector: null, attribute: 'text' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseFieldSpec('  a  @  href ')).toEqual({ selector: 'a', attribute: 'href' });
  });

  it('ignores an @ inside an attribute selector', () => {
    // `lastIndexOf('@')` would split this in the middle of an email address.
    expect(parseFieldSpec('a[href^="mailto:contact@example.com"]')).toEqual({
      selector: 'a[href^="mailto:contact@example.com"]',
      attribute: 'text',
    });
  });

  it('splits correctly when a quoted @ precedes the real separator', () => {
    expect(parseFieldSpec('a[href*="@"]@href')).toEqual({
      selector: 'a[href*="@"]',
      attribute: 'href',
    });
  });

  it('ignores an @ inside a functional pseudo-class', () => {
    expect(parseFieldSpec(':is([data-x="a@b"], .y)@id')).toEqual({
      selector: ':is([data-x="a@b"], .y)',
      attribute: 'id',
    });
  });

  it('handles an escaped quote inside a selector', () => {
    expect(parseFieldSpec('a[title="say \\"@\\" now"]@href')).toEqual({
      selector: 'a[title="say \\"@\\" now"]',
      attribute: 'href',
    });
  });

  it.each(['', '   ', '.title@', 'a @  '])('rejects %j', (spec) => {
    expect(() => parseFieldSpec(spec)).toThrow();
  });
});

describe('parseExtractSpec', () => {
  it('parses every field', () => {
    const parsed = parseExtractSpec({
      selector: '.publication',
      fields: { title: '.title', url: 'a@href' },
    });
    expect(parsed.get('title')).toEqual({ selector: '.title', attribute: 'text' });
    expect(parsed.get('url')).toEqual({ selector: 'a', attribute: 'href' });
  });

  it('names the offending field when one is unusable', () => {
    expect(() =>
      parseExtractSpec({ selector: '.item', fields: { ok: '.a', broken: '.b@' } }),
    ).toThrow(/field "broken"/);
  });

  it('requires an item selector', () => {
    expect(() => parseExtractSpec({ selector: '  ', fields: {} })).toThrow(/selector is required/);
  });

  it('accepts an empty field map', () => {
    expect(parseExtractSpec({ selector: '.item', fields: {} }).size).toBe(0);
  });
});

describe('normalizeText', () => {
  it('collapses whitespace so formatting does not change the value', () => {
    expect(normalizeText('  Note      technique \n  ')).toBe('Note technique');
    expect(normalizeText('a\n\tb')).toBe('a b');
  });

  it('is idempotent', () => {
    const once = normalizeText('  a   b  ');
    expect(normalizeText(once)).toBe(once);
  });

  it('handles an empty string', () => {
    expect(normalizeText('   ')).toBe('');
  });
});
