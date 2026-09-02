/**
 * `snoopit doctor` — is this deployment sound?
 *
 * Written for the moment a crawl is not running and nobody knows why. It checks the
 * things that actually break — Chrome unreachable, migrations not applied, workflows
 * not built, a stale run holding the lock — and says which, rather than leaving an
 * operator to infer it from an empty report.
 *
 * Every check is read-only. Running it can never change the state it is diagnosing.
 */

import { existsSync } from 'node:fs';
import type { LoadedConfig } from '../config/load.js';
import { llmApiKey } from '../config/load.js';
import { MIGRATIONS } from '../state/migrations.js';
import { Store } from '../state/store.js';
import { listWorkflows } from '../runtime/workflow/load.js';
import { isoFromNow, parseDuration } from '../util/time.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about it, when there is something to do. */
  readonly remedy?: string;
}

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

async function checkChrome(cdpUrl: string): Promise<Check> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return {
        name: 'chrome',
        status: 'fail',
        detail: `${cdpUrl} answered ${String(response.status)}`,
        remedy: 'systemctl status snoopit-chrome.service',
      };
    }
    const version = (await response.json()) as { Browser?: string };
    return {
      name: 'chrome',
      status: 'ok',
      detail: `${version.Browser ?? 'connected'} at ${cdpUrl}`,
    };
  } catch {
    return {
      name: 'chrome',
      status: 'fail',
      detail: `no CDP endpoint at ${cdpUrl}`,
      remedy: 'systemctl start snoopit-chrome.service',
    };
  }
}

function checkCdpBinding(cdpUrl: string): Check {
  const host = new URL(cdpUrl).hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return loopback
    ? { name: 'cdp-binding', status: 'ok', detail: `loopback (${host})` }
    : {
        name: 'cdp-binding',
        status: 'fail',
        detail: `CDP is configured at ${host}, not loopback`,
        // This port grants full control of a browser holding authenticated sessions.
        remedy: 'bind the debug port to 127.0.0.1 and reachable only from this host',
      };
}

function checkDatabase(paths: LoadedConfig['paths']): Check[] {
  if (!existsSync(paths.databaseFile)) {
    return [
      {
        name: 'database',
        status: 'fail',
        detail: `no database at ${paths.databaseFile}`,
        remedy: 'snoopit migrate',
      },
    ];
  }

  const store = Store.open({ path: paths.databaseFile, migrate: false });
  try {
    const version = store.schemaVersion;
    const checks: Check[] = [
      version === MIGRATIONS.length
        ? { name: 'database', status: 'ok', detail: `schema v${String(version)}, up to date` }
        : {
            name: 'database',
            status: 'fail',
            detail: `schema v${String(version)}, expected v${String(MIGRATIONS.length)}`,
            remedy: 'snoopit migrate',
          },
    ];

    const jobs = store.jobs.list();
    checks.push({
      name: 'jobs',
      status: jobs.length === 0 ? 'warn' : 'ok',
      detail: `${String(jobs.length)} job(s), ${String(jobs.filter((job) => job.enabled).length)} enabled`,
      ...(jobs.length === 0 ? { remedy: 'run a workflow once to create its job' } : {}),
    });

    // A run left `running` by a killed process blocks its job until its heartbeat
    // goes stale. Worth naming, because the symptom is "nothing happens".
    const stale = store.runs.findStale(isoFromNow(-parseDuration('75s')));
    checks.push(
      stale.length === 0
        ? { name: 'stale-runs', status: 'ok', detail: 'none' }
        : {
            name: 'stale-runs',
            status: 'warn',
            detail: `${String(stale.length)} run(s) left running by a dead process`,
            remedy: 'the next run of each job reclaims them automatically',
          },
    );
    return checks;
  } finally {
    store.close();
  }
}

function checkWorkflows(): Check {
  const names = listWorkflows();
  return names.length === 0
    ? {
        name: 'workflows',
        status: 'fail',
        detail: 'no compiled workflows found',
        remedy: 'npm run build',
      }
    : { name: 'workflows', status: 'ok', detail: names.join(', ') };
}

function checkLlm(loaded: LoadedConfig, env: NodeJS.ProcessEnv): Check {
  const key = llmApiKey(loaded.config, env);
  return key === null
    ? {
        name: 'llm',
        status: 'warn',
        // Not a failure: a nominal run makes no model call, and L1 handles most surprises.
        detail: `no key in ${loaded.config.llm.apiKeyEnv} — recovery stops at L1`,
        remedy: `set ${loaded.config.llm.apiKeyEnv} to enable L2/L3 recovery`,
      }
    : {
        name: 'llm',
        status: 'ok',
        detail: `${loaded.config.llm.provider}/${loaded.config.llm.model}`,
      };
}

export async function runDoctor(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  return [
    checkCdpBinding(loaded.config.browser.cdpUrl),
    await checkChrome(loaded.config.browser.cdpUrl),
    ...checkDatabase(loaded.paths),
    checkWorkflows(),
    checkLlm(loaded, env),
  ];
}

export function formatChecks(checks: readonly Check[]): string {
  return checks
    .flatMap((check) => {
      const line = `${MARK[check.status]} ${check.name.padEnd(14)} ${check.detail}`;
      return check.remedy === undefined ? [line] : [line, `${' '.repeat(18)}→ ${check.remedy}`];
    })
    .join('\n');
}

/** Exit code: 1 when any check failed, 0 otherwise. Warnings are not failures. */
export function exitCodeFor(checks: readonly Check[]): number {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}
