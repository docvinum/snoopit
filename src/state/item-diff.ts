/**
 * Comparing two observations of the same item. Pure, so the rules are testable
 * without a database.
 */

import { contentHash } from '../util/hash.js';
import type { ItemDiff, ItemFields, ItemValue } from './types.js';

/**
 * Hash of an item's fields, independent of key order. `{a, b}` and `{b, a}` are the
 * same observation; a hash that disagreed would report a change that is not one.
 */
export function fieldsHash(fields: ItemFields): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((name) => [name, fields[name] ?? null]);
  return contentHash(JSON.stringify(sorted));
}

/**
 * Field-level changes from `before` to `after`.
 *
 * Compared over the union of both key sets: a field that disappears reads as a
 * change to `null`, one that appears as a change from `null`. Values are compared
 * strictly — `12` and `"12"` differ, so extract numbers as numbers.
 */
export function diffFields(before: ItemFields, after: ItemFields): ItemDiff {
  const diff: Record<string, { from: ItemValue; to: ItemValue }> = {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort()) {
    const from = before[name] ?? null;
    const to = after[name] ?? null;
    if (from !== to) diff[name] = { from, to };
  }
  return diff;
}
