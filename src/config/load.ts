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

  const llmModel = env['SNOOPIT_LLM_MODEL'];
  const llmBaseUrl = env['SNOOPIT_LLM_BASE_URL'];
  if (llmModel !== undefined || llmBaseUrl !== undefined) {
    raw['llm'] = {
      ...(raw['llm'] as object | undefined),
      ...(llmModel !== undefined && llmModel !== '' ? { model: llmModel } : {}),
      ...(llmBaseUrl !== undefined && llmBaseUrl !== '' ? { baseUrl: llmBaseUrl } : {}),
    };
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

/**
 * Reads the LLM API key from the environment variable the config points at.
 *
 * Returns `null` when unset. A missing key is only an error at the moment an L2/L3
 * recovery is actually attempted — a nominal run makes no LLM call at all, and must
 * not require a key to start.
 */
export function llmApiKey(config: Config, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[config.llm.apiKeyEnv];
  return value === undefined || value === '' ? null : value;
}

// Note: there is deliberately no `redactConfig()` helper. The config object holds no
// secret to redact — `llm.apiKeyEnv` is the *name* of an environment variable, and the
// key itself is read on demand by `llmApiKey()` and never stored on the config. A
// redaction helper here would imply secrets flow through this object; they do not.
