/** Helpers shared by the repositories for row <-> domain translation. */

/** SQLite bindings reject `undefined`; every optional input goes through this. */
export function orNull<T>(value: T | null | undefined): T | null {
  return value === undefined || value === null ? null : value;
}

export function toBool(value: number): boolean {
  return value !== 0;
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Parses a JSON column. A malformed value yields `null` rather than throwing:
 * one corrupt metadata blob must not make a whole crawl unreadable.
 */
export function fromJson<T>(value: string | null): T | null {
  if (value === null || value === '') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
