import { z } from 'zod';

/**
 * Configuration schema.
 *
 * One rule shapes this file: **no secret is ever a config value.** The LLM API key
 * is referenced by the *name of an environment variable* (`apiKeyEnv`), never by its
 * value, so a config file can be committed without redaction. The upstream project
 * stored its key in browser storage in plain text; this is the deliberate opposite.
 */

const durationPattern = /^\d+(\.\d+)?(ms|s|m|h|d)(\d+(\.\d+)?(ms|s|m|h|d))*$/;
const clockPattern = /^([01]?\d|2[0-3]):[0-5]\d$/;

export const budgetSchema = z
  .object({
    maxPages: z.number().int().positive().optional(),
    maxDuration: z.string().regex(durationPattern, 'expected a duration like "20m"').optional(),
    maxDownloadBytes: z.number().int().positive().optional(),
    maxLlmCalls: z.number().int().nonnegative().optional(),
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
        defaultProfile: z.string().default('desktop-chrome'),
        navigationTimeout: z
          .string()
          .regex(durationPattern, 'expected a duration like "30s"')
          .default('30s'),
      })
      .strict()
      .default({}),

    llm: z
      .object({
        /** Any OpenAI-compatible endpoint. The business layer never names a vendor. */
        provider: z.string().default('openrouter'),
        baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),
        model: z.string().default('anthropic/claude-sonnet-4.6'),
        /** Name of the env var holding the key. Never the key itself. */
        apiKeyEnv: z.string().default('SNOOPIT_LLM_API_KEY'),
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

    defaultBudget: budgetSchema.default({
      maxPages: 100,
      maxDuration: '20m',
      maxLlmCalls: 3,
      maxErrors: 10,
    }),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
