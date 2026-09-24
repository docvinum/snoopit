/**
 * `snoopit run` with `browser.backend: extension`, end to end.
 *
 * The real CLI, in its own process, opens the loopback endpoint; a real Chromium
 * with the extension loaded — and no debugging port — connects and executes the
 * catalogue workflow. Proves the whole chain a deployment on dell relies on: config,
 * token from the environment, pairing, run, report.
 *
 * Skipped without a built `dist/` or without Chromium.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/state/store.js';
import {
  extensionBrowserAvailable,
  launchExtensionBrowser,
  type ExtensionBrowser,
} from '../support/extension-browser.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const CLI = resolve('dist/src/cli/main.js');
const PORT = 19560;
const TOKEN = 'conformance-test-pairing-token-0123456789';

let server: FixtureServer;
let browser: ExtensionBrowser | null = null;

beforeAll(async () => {
  server = await startFixtureServer({ catalogueSize: 4 });
  if (existsSync(CLI) && extensionBrowserAvailable()) browser = await launchExtensionBrowser(PORT);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server.close();
});

describe('snoopit run through the extension', () => {
  it('runs a workflow in a Chrome that has no debugging port', async () => {
    if (browser === null) {
      console.error('[extension-run] skipped: no built dist/ or no Chromium');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'snoopit-ext-run-'));
    const configFile = join(dir, 'snoopit.config.yaml');
    writeFileSync(
      configFile,
      [
        `dataDir: ${join(dir, 'data')}`,
        'browser:',
        '  backend: extension',
        '  extension:',
        `    port: ${String(PORT)}`,
        '    connectTimeout: 20s',
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [CLI, 'run', 'example-catalogue', '--config', configFile],
      {
        env: {
          ...process.env,
          SNOOPIT_EXTENSION_TOKEN: TOKEN,
          SNOOPIT_CATALOGUE_URL: server.url('/catalogue.html'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    // The CLI is listening once it started; ask the extension to connect now
    // rather than at its next 30 s alarm.
    await new Promise((r) => setTimeout(r, 1_500));
    await browser.nudge();

    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code, output).toBe(0);

    const store = Store.open({ path: join(dir, 'data', 'snoopit.db'), migrate: false });
    try {
      const run = store.runs.latestForJob('example-catalogue');
      expect(run?.status).toBe('completed');
      expect(run?.counters.artifactsCreated).toBeGreaterThan(0);
      expect(run?.counters.llmCalls).toBe(0);
    } finally {
      store.close();
    }
  }, 90_000);
});
