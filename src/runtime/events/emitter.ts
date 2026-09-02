/**
 * Domain events, written twice.
 *
 * Every event goes to SQLite (queryable across runs) *and* to an `events.jsonl` in
 * the run directory (readable with `tail -f`, greppable, portable). Both are durable
 * and neither expires: the project we audited kept its events for three minutes and
 * its history for a day, which is precisely why nothing there could be explained
 * afterwards.
 *
 * The JSONL file is appended synchronously as events happen rather than flushed at
 * the end, so a run killed mid-flight still leaves a readable trace of how far it
 * got. That is the same reason the run's own row carries a heartbeat.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../../state/store.js';
import type { EventLevel, EventType, RunEvent } from '../../state/types.js';
import { nowIso } from '../../util/time.js';

export interface EmitInput {
  readonly type: EventType;
  readonly level?: EventLevel;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly message?: string | null;
  readonly data?: Record<string, unknown> | null;
}

export interface EventEmitterOptions {
  readonly store: Store;
  readonly jobId: string;
  readonly runId: string;
  /** Absolute path of the run's `events.jsonl`. Omit to write only to SQLite. */
  readonly jsonlPath?: string;
  /** Receives a human-readable line per event. Defaults to stderr. */
  readonly onLine?: (line: string) => void;
}

const LEVEL_MARK: Record<EventLevel, string> = { info: ' ', warn: '!', error: 'x' };

/** Formats an event as one readable line. Logs complement the record, never replace it. */
export function formatEventLine(event: RunEvent): string {
  const mark = LEVEL_MARK[event.level];
  const where = event.url ?? '';
  const detail = event.message ?? '';
  return [`[${mark}]`, event.type.padEnd(20), where, detail]
    .filter((p) => p !== '')
    .join(' ')
    .trimEnd();
}

export class RunEventEmitter {
  private readonly counts = new Map<EventType, number>();
  private jsonlReady = false;

  constructor(private readonly options: EventEmitterOptions) {}

  emit(input: EmitInput): RunEvent {
    const event = this.options.store.events.append({
      jobId: this.options.jobId,
      runId: this.options.runId,
      type: input.type,
      ...(input.level === undefined ? {} : { level: input.level }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.data === undefined ? {} : { data: input.data }),
    });

    this.counts.set(input.type, (this.counts.get(input.type) ?? 0) + 1);
    this.appendJsonl(event);

    const line = formatEventLine(event);
    if (this.options.onLine === undefined) {
      console.error(line);
    } else {
      this.options.onLine(line);
    }
    return event;
  }

  private appendJsonl(event: RunEvent): void {
    const path = this.options.jsonlPath;
    if (path === undefined) return;

    if (!this.jsonlReady) {
      mkdirSync(dirname(path), { recursive: true });
      this.jsonlReady = true;
    }
    // One JSON object per line, appended as it happens: a killed run still leaves a
    // readable trace of exactly how far it got.
    appendFileSync(
      path,
      `${JSON.stringify({
        at: event.at,
        type: event.type,
        level: event.level,
        url: event.url,
        canonicalUrl: event.canonicalUrl,
        message: event.message,
        data: event.data,
      })}\n`,
      'utf8',
    );
  }

  /** How many of each event type this run emitted. Feeds the run report. */
  countsByType(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  count(type: EventType): number {
    return this.counts.get(type) ?? 0;
  }
}

/** An emitter that records nothing. Useful when a helper is called outside a run. */
export function nullEmitter(): Pick<RunEventEmitter, 'emit' | 'countsByType' | 'count'> {
  return {
    emit: (input: EmitInput): RunEvent => ({
      id: 0,
      jobId: '',
      runId: null,
      at: nowIso(),
      type: input.type,
      level: input.level ?? 'info',
      url: input.url ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      message: input.message ?? null,
      data: input.data ?? null,
    }),
    countsByType: () => ({}),
    count: () => 0,
  };
}
