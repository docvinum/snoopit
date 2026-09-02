import { describe, expect, it } from 'vitest';
import { isoPlus, nowIso, parseClockTime, parseDuration } from '../../src/util/time.js';
import { contentHash } from '../../src/util/hash.js';

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['20m', 1_200_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1h30m', 5_400_000],
    ['1d2h30m', 95_400_000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '  ', '20', 'm', '20x', '20 m', 'twenty minutes', '20m junk'])(
    'rejects %j rather than guessing',
    (input) => {
      expect(() => parseDuration(input)).toThrow();
    },
  );
});

describe('parseClockTime', () => {
  it.each([
    ['00:00', 0],
    ['08:00', 480],
    ['8:30', 510],
    ['23:59', 1439],
  ])('parses %s', (input, expected) => {
    expect(parseClockTime(input)).toBe(expected);
  });

  it.each(['24:00', '12:60', '12', '12:5', 'noon', ''])('rejects %j', (input) => {
    expect(() => parseClockTime(input)).toThrow();
  });
});

describe('ISO timestamps', () => {
  it('produces sortable UTC strings', () => {
    const now = nowIso();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Lexicographic order must match chronological order — every ORDER BY relies on it.
    expect(isoPlus(now, 1000) > now).toBe(true);
    expect(isoPlus(now, -1000) < now).toBe(true);
  });

  it('adds milliseconds across a day boundary', () => {
    expect(isoPlus('2026-08-31T23:30:00.000Z', 3_600_000)).toBe('2026-09-01T00:30:00.000Z');
  });
});

describe('contentHash', () => {
  it('is stable, algorithm-prefixed, and sensitive to change', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash('hello')).not.toBe(contentHash('hello '));
  });

  it('hashes bytes and the equivalent string identically', () => {
    expect(contentHash(new TextEncoder().encode('hello'))).toBe(contentHash('hello'));
  });
});
