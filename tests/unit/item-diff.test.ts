import { describe, expect, it } from 'vitest';
import { diffFields, fieldsHash } from '../../src/state/item-diff.js';

describe('fieldsHash', () => {
  it('does not depend on key order', () => {
    expect(fieldsHash({ titre: 'Vélo', prix: 250 })).toBe(fieldsHash({ prix: 250, titre: 'Vélo' }));
  });

  it('changes when a value changes', () => {
    expect(fieldsHash({ prix: 250 })).not.toBe(fieldsHash({ prix: 220 }));
  });
});

describe('diffFields', () => {
  it('reports only the fields that moved', () => {
    expect(diffFields({ titre: 'Vélo', prix: 250 }, { titre: 'Vélo', prix: 220 })).toEqual({
      prix: { from: 250, to: 220 },
    });
  });

  it('reads a field that appears or disappears as a change from or to null', () => {
    expect(diffFields({ a: 1 }, { b: 2 })).toEqual({
      a: { from: 1, to: null },
      b: { from: null, to: 2 },
    });
  });

  it('compares strictly: a number is not its string', () => {
    expect(diffFields({ prix: 250 }, { prix: '250' })).toEqual({
      prix: { from: 250, to: '250' },
    });
  });

  it('is empty for identical observations', () => {
    expect(diffFields({ a: 1, b: null }, { b: null, a: 1 })).toEqual({});
  });
});
