/**
 * Time helpers.
 *
 * Every timestamp persisted by snoopit is an ISO-8601 UTC string. That choice is
 * deliberate: SQLite has no date type, and ISO-8601 UTC sorts lexicographically in
 * the same order it sorts chronologically, so `ORDER BY started_at` is correct
 * without any conversion.
 */

/** Current instant as an ISO-8601 UTC string, e.g. `2026-08-31T08:00:00.000Z`. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 UTC string for an instant `ms` milliseconds from now. */
export function isoFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Adds `ms` to an ISO timestamp, returning a new ISO timestamp. */
export function isoPlus(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses a human duration such as `20m`, `1h30m`, `500ms` into milliseconds.
 *
 * Workflow budgets are written by hand and by coding agents, so the format has to
 * be forgiving to read and strict to parse: anything it cannot parse throws rather
 * than silently becoming a surprising number.
 */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (text === '') throw new Error('parseDuration: empty duration');

  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
  let total = 0;
  let matched = false;
  let index = 0;

  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const [whole, amount, unit] = match;
    total += Number(amount) * DURATION_UNITS[unit!]!;
    matched = true;
    index += whole.length;
    match = pattern.exec(text);
  }

  if (!matched || index !== text.length) {
    throw new Error(`parseDuration: cannot parse "${input}"`);
  }
  return total;
}

/**
 * Parses a `HH:MM` clock time into minutes since midnight.
 * Used by scheduler windows (`from: "08:00"`).
 */
export function parseClockTime(input: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error(`parseClockTime: cannot parse "${input}" (expected HH:MM)`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`parseClockTime: "${input}" is not a valid time of day`);
  }
  return hours * 60 + minutes;
}
