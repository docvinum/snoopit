import { z } from 'zod';
import { isValidTimeZone } from '../util/time.js';

/**
 * Configuration schema.
 *
 * This configuration describes snoopit's deterministic runtime. Agent credentials
 * belong to the external caller, never to snoopit.
 */

const durationPattern = /^\d+(\.\d+)?(ms|s|m|h|d)(\d+(\.\d+)?(ms|s|m|h|d))*$/;
const clockPattern = /^([01]?\d|2[0-3]):[0-5]\d$/;
const timeZone = z
  .string()
  .refine(isValidTimeZone, { message: 'expected an IANA time zone, e.g. "Europe/Paris"' });

export const budgetSchema = z
  .object({
    maxPages: z.number().int().positive().optional(),
    maxDuration: z.string().regex(durationPattern, 'expected a duration like "20m"').optional(),
    maxDownloadBytes: z.number().int().positive().optional(),
    maxErrors: z.number().int().nonnegative().optional(),
  })
  .strict();

export const scheduleSchema = z
  .object({
    frequency: z.enum(['manual', 'hourly', 'daily', 'weekly']),
    window: z
      .object({
        from: z.string().regex(clockPattern, 'expected HH:MM'),
        to: z.string().regex(clockPattern, 'expected HH:MM'),
      })
      .strict()
      .optional(),
    pagesPerRun: z
      .object({ min: z.number().int().nonnegative(), max: z.number().int().positive() })
      .strict()
      .refine((value) => value.min <= value.max, { message: 'min must be <= max' })
      .optional(),
    /** Zone the window is read in. Falls back to `scheduler.timeZone`. */
    timeZone: timeZone.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    /** Root of everything written to disk: database, artifacts, run directories. */
    dataDir: z.string().default('./data'),

    database: z
      .object({
        /** Relative paths resolve against `dataDir`. */
        path: z.string().default('snoopit.db'),
      })
      .strict()
      .default({ path: 'snoopit.db' }),

    browser: z
      .object({
        /**
         * CDP endpoint of the persistent Chrome (decision D2).
         * Loopback only — the audit found the upstream proxy listening on every
         * interface with no authentication, and this is that lesson encoded.
         */
        cdpUrl: z.string().url().default('http://127.0.0.1:9222'),
        /**
         * How snoopit drives Chrome. `cdp`: over the remote-debugging port of a
         * Chrome it attaches to. `extension`: through snoopit's extension, inside a
         * Chrome with no debugging port at all — one a person can see and use.
         */
        backend: z.enum(['cdp', 'extension']).default('cdp'),
        extension: z
          .object({
            /** Loopback port snoopit opens during a run; the extension connects to it. */
            port: z.number().int().min(1024).max(65535).default(9333),
            /** Name of the env var holding the pairing token. Never the token itself. */
            tokenEnv: z.string().default('SNOOPIT_EXTENSION_TOKEN'),
            /** How long a run waits for the extension. It retries every 30 s at least. */
            connectTimeout: z
              .string()
              .regex(durationPattern, 'expected a duration like "45s"')
              .default('45s'),
          })
          .strict()
          .default({}),
        defaultProfile: z.string().default('desktop-chrome'),
        navigationTimeout: z
          .string()
          .regex(durationPattern, 'expected a duration like "30s"')
          .default('30s'),
      })
      .strict()
      .default({}),

    runs: z
      .object({
        /** How often a live run refreshes its heartbeat. */
        heartbeatInterval: z
          .string()
          .regex(durationPattern, 'expected a duration like "15s"')
          .default('15s'),
        /**
         * How long a run may go without a heartbeat before it counts as dead and its
         * work is reclaimed. Must comfortably exceed `heartbeatInterval`, or a slow
         * run declares itself abandoned. Lower it to resume sooner after a crash;
         * raise it if runs are long and the machine is loaded.
         */
        staleAfter: z
          .string()
          .regex(durationPattern, 'expected a duration like "75s"')
          .default('75s'),
      })
      .strict()
      .default({}),

    scheduler: z
      .object({
        /**
         * Zone in which schedule windows are read when a job does not name its own.
         * A window of `08:00`–`10:00` means local time to whoever wrote it; left at
         * UTC on a machine in France it silently fires one or two hours late.
         */
        timeZone: timeZone.default('UTC'),
      })
      .strict()
      .default({}),

    defaultBudget: budgetSchema.default({
      maxPages: 100,
      maxDuration: '20m',
      maxErrors: 10,
    }),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
