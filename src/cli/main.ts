#!/usr/bin/env node
/**
 * snoopit CLI.
 *
 * Lot 1 ships the commands that operate on state alone — no browser is involved.
 * `run` and `schedule` arrive with Lots 3 and 4.
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/load.js';
import { CdpBackend } from '../runtime/browser/cdp.js';
import { listWorkflows, loadWorkflow } from '../runtime/workflow/load.js';
import { runWorkflow } from '../runtime/workflow/runner.js';
import { canonicalizeUrl } from '../runtime/navigation/canonical.js';
import { appliedMigrations } from '../state/db.js';
import { Store } from '../state/store.js';
import { MIGRATIONS } from '../state/migrations.js';

const USAGE = `snoopit — orchestrateur de visites web persistantes

Usage:
  snoopit migrate                Apply pending schema migrations
  snoopit status                 Show configuration, schema version and job summary
  snoopit run <workflow>         Run a workflow once, against the persistent Chrome
  snoopit workflows              List available workflows
  snoopit canon <url...>         Canonicalise URLs (the identity function used for dedup)
  snoopit help                   Show this message

Options:
  --config <file>                Path to a config file (default: ./snoopit.config.yaml)
  --job <id>                     Job to attribute the run to (default: the workflow name)
`;

interface ParsedArgs {
  readonly command: string;
  readonly rest: readonly string[];
  readonly configFile: string | undefined;
  readonly jobName: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest: string[] = [];
  let configFile: string | undefined;
  let jobName: string | undefined;
  let command = 'help';
  let seenCommand = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--config requires a path');
      configFile = value;
      i += 1;
    } else if (arg === '--job') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--job requires a name');
      jobName = value;
      i += 1;
    } else if (!seenCommand) {
      command = arg;
      seenCommand = true;
    } else {
      rest.push(arg);
    }
  }
  return { command, rest, configFile, jobName };
}

function cmdMigrate(configFile: string | undefined): number {
  const loaded = loadConfig(configFile === undefined ? {} : { file: configFile });
  // Opening with `migrate: false` first lets us report what *was* there before.
  const before = Store.open({ path: loaded.paths.databaseFile, migrate: false });
  const previous = before.schemaVersion;
  before.close();

  const store = Store.open({ path: loaded.paths.databaseFile });
  const now = store.schemaVersion;
  console.log(`database: ${loaded.paths.databaseFile}`);
  console.log(
    previous === now
      ? `schema already at version ${String(now)} — nothing to do`
      : `schema migrated ${String(previous)} -> ${String(now)}`,
  );
  store.close();
  return 0;
}

function cmdStatus(configFile: string | undefined): number {
  const loaded = loadConfig(configFile === undefined ? {} : { file: configFile });
  const store = Store.open({ path: loaded.paths.databaseFile });

  console.log(`config:   ${loaded.sourcePath ?? '(defaults, no config file found)'}`);
  console.log(`data dir: ${loaded.paths.dataDir}`);
  console.log(`database: ${loaded.paths.databaseFile}`);
  console.log(`cdp url:  ${loaded.config.browser.cdpUrl}`);
  console.log(
    `schema:   version ${String(store.schemaVersion)} of ${String(MIGRATIONS.length)} ` +
      `(${String(appliedMigrations(store.db).length)} applied)`,
  );

  const jobs = store.jobs.list();
  console.log(`jobs:     ${String(jobs.length)}`);
  for (const job of jobs) {
    const latest = store.runs.latestForJob(job.id);
    const pages = store.pages.countByStatus(job.id);
    const pending = store.frontier.remaining(job.id);
    console.log(
      `  - ${job.id}${job.enabled ? '' : ' (disabled)'}: ` +
        `last run ${latest === null ? 'never' : `${latest.startedAt} [${latest.status}]`}, ` +
        `pages ${JSON.stringify(pages)}, frontier pending ${String(pending)}`,
    );
  }
  store.close();
  return 0;
}

async function cmdRun(
  name: string | undefined,
  configFile: string | undefined,
  jobName: string | undefined,
): Promise<number> {
  if (name === undefined) {
    console.error('run: expected a workflow name');
    return 2;
  }

  const loaded = loadConfig(configFile === undefined ? {} : { file: configFile });
  const definition = await loadWorkflow(name);
  const store = Store.open({ path: loaded.paths.databaseFile });

  try {
    // A job row is what gives a run its memory across executions: same job id, same
    // crawl_pages and frontier, so a second run resumes rather than restarts.
    const job = store.jobs.upsert({
      name: jobName ?? definition.name,
      workflow: definition.name,
      ...(definition.browserProfile === undefined
        ? {}
        : { browserProfile: definition.browserProfile }),
      ...(definition.networkProfile === undefined
        ? {}
        : { networkProfile: definition.networkProfile }),
      ...(definition.budget === undefined ? {} : { budget: definition.budget }),
    });

    const browser = await CdpBackend.connect({ cdpUrl: loaded.config.browser.cdpUrl });

    try {
      const outcome = await runWorkflow(definition, {
        store,
        job,
        browser,
        dataDir: loaded.paths.dataDir,
        trigger: 'manual',
      });

      console.log('');
      console.log(`run:      ${outcome.run.id} [${outcome.run.status}]`);
      console.log(`report:   ${outcome.reportPath}`);
      console.log(`json:     ${outcome.reportJsonPath}`);
      return outcome.error === null ? 0 : 1;
    } finally {
      await browser.close();
    }
  } finally {
    store.close();
  }
}

function cmdWorkflows(): number {
  const names = listWorkflows();
  if (names.length === 0) {
    console.log('No compiled workflows found. Run `npm run build` first.');
    return 0;
  }
  for (const name of names) console.log(name);
  return 0;
}

function cmdCanon(urls: readonly string[]): number {
  if (urls.length === 0) {
    console.error('canon: expected at least one URL');
    return 2;
  }
  let failures = 0;
  for (const url of urls) {
    const result = canonicalizeUrl(url);
    if (result.ok) {
      console.log(`${url}\n  -> ${result.canonical}`);
    } else {
      console.log(`${url}\n  -> SKIPPED (${result.reason})`);
      failures += 1;
    }
  }
  return failures === urls.length ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    switch (parsed.command) {
      case 'migrate':
        return cmdMigrate(parsed.configFile);
      case 'status':
        return cmdStatus(parsed.configFile);
      case 'run':
        return await cmdRun(parsed.rest[0], parsed.configFile, parsed.jobName);
      case 'workflows':
        return cmdWorkflows();
      case 'canon':
        return cmdCanon(parsed.rest);
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      default:
        console.error(`Unknown command: ${parsed.command}\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only run when invoked directly, so tests can import `main` without side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
