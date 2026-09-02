/**
 * The MVP acceptance criterion, executed for real.
 *
 *   1. Run a job against the local fixture site, budget = 10 pages.
 *   2. Kill it brutally at document 6.
 *   3. Run it again.
 *   4. Check: resumes at 7, nothing re-downloaded, nothing skipped, both runs
 *      recorded, each report coherent.
 *
 * Nothing here is simulated: a real child process runs the real CLI against a real
 * Chrome, and is killed with SIGKILL — no cleanup handler, no chance to flush. That
 * is the only way to know the record on disk is genuinely durable rather than
 * written by a well-behaved shutdown path.
 *
 * Skipped when Chrome or the build is absent; the state-level equivalent lives in
 * `tests/integration/resume.test.ts` and runs everywhere.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/state/store.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const CDP_URL = process.env['SNOOPIT_TEST_CDP_URL'] ?? 'http://127.0.0.1:9222';
const CLI = resolve('dist/src/cli/main.js');
/**
 * The catalogue holds ten documents; the workflow's budget is ten units of crawl
 * work per run, one of which is the index page. So no single run can finish the
 * catalogue — which is the point: it takes the resumed run to complete it.
 */
const CATALOGUE_SIZE = 10;
const KILL_AFTER_DOCUMENTS = 6;

let server: FixtureServer;
let ready = false;
let skipReason = '';

beforeAll(async () => {
  // A slow-ish server is what creates a window in which to kill the crawl.
  server = await startFixtureServer({ documentDelayMs: 120, catalogueSize: 10 });

  if (!existsSync(CLI)) {
    skipReason = 'dist not built — run `npm run build` first';
    return;
  }
  try {
    const probe = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!probe.ok) skipReason = `Chrome not reachable at ${CDP_URL}`;
    else ready = true;
  } catch {
    skipReason = `Chrome not reachable at ${CDP_URL}`;
  }
});

afterAll(async () => {
  await server.close();
});

interface Workspace {
  readonly dir: string;
  readonly configFile: string;
  readonly dbFile: string;
}

function makeWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'snoopit-kill-'));
  const configFile = join(dir, 'snoopit.config.yaml');
  // A short stale window so the resume happens immediately rather than after the
  // 75s production default. Operators tune this the same way when restarting by hand.
  writeFileSync(
    configFile,
    [
      `dataDir: ${join(dir, 'data')}`,
      'browser:',
      `  cdpUrl: ${CDP_URL}`,
      'runs:',
      '  heartbeatInterval: 1s',
      '  staleAfter: 2s',
      '',
    ].join('\n'),
    'utf8',
  );
  return { dir, configFile, dbFile: join(dir, 'data', 'snoopit.db') };
}

function spawnRun(workspace: Workspace): ChildProcess {
  return spawn(
    process.execPath,
    [CLI, 'run', 'example-catalogue', '--config', workspace.configFile],
    {
      env: {
        ...process.env,
        SNOOPIT_CATALOGUE_URL: server.url('/catalogue.html'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** Counts artifacts recorded so far, reading the durable record rather than stdout. */
function artifactsOnDisk(workspace: Workspace): number {
  if (!existsSync(workspace.dbFile)) return 0;
  const store = Store.open({ path: workspace.dbFile, migrate: false });
  try {
    const row = store.db
      .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'pdf'")
      .get() as { n: number };
    return row.n;
  } catch {
    return 0;
  } finally {
    store.close();
  }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise(code));
  });
}

describe('kill -9 and resume', () => {
  it('resumes exactly where it was killed, re-downloading nothing', async () => {
    if (!ready) {
      console.error(`[kill-resume] skipped: ${skipReason}`);
      return;
    }

    const workspace = makeWorkspace();

    // ── 1 & 2 : run, then kill brutally partway through ───────────────────
    const first = spawnRun(workspace);
    let killedAfter = 0;

    await new Promise<void>((resolvePromise) => {
      const poll = setInterval(() => {
        const count = artifactsOnDisk(workspace);
        if (count >= KILL_AFTER_DOCUMENTS) {
          clearInterval(poll);
          killedAfter = count;
          // SIGKILL: no handler runs, nothing is flushed on the way out.
          first.kill('SIGKILL');
          resolvePromise();
        }
      }, 25);

      first.on('exit', () => {
        clearInterval(poll);
        killedAfter = artifactsOnDisk(workspace);
        resolvePromise();
      });
    });

    const firstExit = await waitForExit(first);
    expect(killedAfter).toBeGreaterThanOrEqual(KILL_AFTER_DOCUMENTS);
    expect(killedAfter).toBeLessThan(CATALOGUE_SIZE);
    // Confirms the process really was killed rather than exiting on its own.
    expect(firstExit).not.toBe(0);

    const afterKill = new Store(Store.open({ path: workspace.dbFile, migrate: false }).db);
    const jobId = 'example-catalogue';
    const collectedBeforeKill = afterKill.artifacts
      .listByJob(jobId, 1000)
      .filter((artifact) => artifact.kind === 'pdf');
    const killedRun = afterKill.runs.listByJob(jobId)[0]!;

    // The killed run is still marked running: nothing got to close it.
    expect(killedRun.status).toBe('running');
    afterKill.close();

    // ── 3 : run again ─────────────────────────────────────────────────────
    // Wait out the (deliberately short) stale window, so the dead run is reclaimable.
    await new Promise((r) => setTimeout(r, 2500));

    const second = spawnRun(workspace);
    const secondErrors: string[] = [];
    second.stderr?.on('data', (chunk: Buffer) => secondErrors.push(chunk.toString()));
    const secondExit = await waitForExit(second);
    expect(secondExit, secondErrors.join('')).toBe(0);

    // ── 4 : verify ────────────────────────────────────────────────────────
    const store = Store.open({ path: workspace.dbFile, migrate: false });
    try {
      const runs = store.runs.listByJob(jobId);
      expect(runs).toHaveLength(2);

      const [latest, earlier] = runs;
      expect(latest!.status).toBe('completed');
      // The killed run was closed as abandoned, not deleted: it did real work.
      expect(earlier!.status).toBe('aborted');
      expect(earlier!.stopReason).toBe('abandoned');

      const pdfs = store.artifacts.listByJob(jobId, 1000).filter((a) => a.kind === 'pdf');
      const paths = pdfs.map((artifact) => artifact.path);

      // Nothing skipped: the whole catalogue is present.
      expect(pdfs).toHaveLength(CATALOGUE_SIZE);
      // Nothing re-downloaded: every path is distinct.
      expect(new Set(paths).size).toBe(CATALOGUE_SIZE);
      // Everything collected before the kill survived it.
      for (const before of collectedBeforeKill) {
        expect(paths).toContain(before.path);
      }
      // And the second run only did what was left.
      const secondRunPdfs = store.artifacts.listByRun(latest!.id).filter((a) => a.kind === 'pdf');
      expect(secondRunPdfs).toHaveLength(CATALOGUE_SIZE - collectedBeforeKill.length);

      // Both reports exist and are coherent.
      const dataDir = join(workspace.dir, 'data');
      const report = JSON.parse(
        readFileSync(resolve(dataDir, latest!.reportPath!.replace(/\.md$/, '.json')), 'utf8'),
      ) as { run: { status: string; stopReason: string }; counters: { pagesVisited: number } };

      expect(report.run.status).toBe('completed');
      // Stopping on a budget is a clean stop, never a failure.
      expect(report.run.stopReason).toMatch(/^(done|budget:max_pages)$/);

      // Every file is really on disk with the recorded bytes.
      for (const artifact of pdfs) {
        const bytes = readFileSync(resolve(dataDir, artifact.path));
        expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        expect(artifact.bytes).toBe(bytes.byteLength);
      }
    } finally {
      store.close();
    }
  }, 120_000);
});
