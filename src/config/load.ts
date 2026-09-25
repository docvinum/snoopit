import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type Config } from './schema.js';

export const DEFAULT_CONFIG_FILENAME = 'snoopit.config.yaml';

export interface LoadedConfig {
  readonly config: Config;
  /** Absolute path of the file that was read, or `null` when defaults were used. */
  readonly sourcePath: string | null;
  /** Absolute, resolved paths derived from the config. */
  readonly paths: ResolvedPaths;
}

export interface ResolvedPaths {
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly jobsDir: string;
}

export interface LoadConfigOptions {
  /** Explicit config file. When omitted, `snoopit.config.yaml` in `cwd` is used if present. */
  readonly file?: string;
  readonly cwd?: string;
  /** Environment used for overrides. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Environment overrides, applied on top of the file. Deployment beats the repo. */
function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const dataDir = env['SNOOPIT_DATA_DIR'];
  if (dataDir !== undefined && dataDir !== '') raw['dataDir'] = dataDir;

  const dbPath = env['SNOOPIT_DB_PATH'];
  if (dbPath !== undefined && dbPath !== '') {
    raw['database'] = { ...(raw['database'] as object | undefined), path: dbPath };
  }

  const cdpUrl = env['SNOOPIT_CDP_URL'];
  if (cdpUrl !== undefined && cdpUrl !== '') {
    raw['browser'] = { ...(raw['browser'] as object | undefined), cdpUrl };
  }
}

/**
 * Configuration written before 2026-09-25 can still contain local-model
 * settings. They are deliberately discarded during loading: models belong to
 * the caller of snoopit, not to its runtime. Keeping this one-way migration
 * lets an installed instance upgrade before its YAML is cleaned up.
 */
function discardLegacyLlmSettings(raw: Record<string, unknown>): void {
  delete raw['llm'];

  const budget = raw['defaultBudget'];
  if (budget !== null && typeof budget === 'object' && !Array.isArray(budget)) {
    delete (budget as Record<string, unknown>)['maxLlmCalls'];
  }
}

function resolvePaths(config: Config, cwd: string): ResolvedPaths {
  const dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(cwd, config.dataDir);
  const databaseFile = isAbsolute(config.database.path)
    ? config.database.path
    : resolve(dataDir, config.database.path);
  return { dataDir, databaseFile, jobsDir: resolve(dataDir, 'jobs') };
}

/**
 * Loads configuration from YAML, applies environment overrides, validates.
 *
 * A missing config file is not an error: the defaults are a working configuration.
 * An invalid one is a hard failure with the offending field named — a silently
 * ignored setting is worse than a refusal to start.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const candidate = options.file ?? resolve(cwd, DEFAULT_CONFIG_FILENAME);
  const sourcePath = existsSync(candidate) ? resolve(candidate) : null;

  if (options.file !== undefined && sourcePath === null) {
    throw new Error(`Config file not found: ${options.file}`);
  }

  let raw: Record<string, unknown> = {};
  if (sourcePath !== null) {
    const parsed: unknown = parseYaml(readFileSync(sourcePath, 'utf8'));
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Config file ${sourcePath} must contain a YAML mapping`);
      }
      raw = parsed as Record<string, unknown>;
    }
  }

  discardLegacyLlmSettings(raw);
  applyEnvOverrides(raw, env);

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration${sourcePath === null ? '' : ` in ${sourcePath}`}:\n${details}`,
    );
  }

  return { config: result.data, sourcePath, paths: resolvePaths(result.data, cwd) };
}
