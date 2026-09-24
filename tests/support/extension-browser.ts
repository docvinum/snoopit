/**
 * A real Chromium with snoopit's extension loaded, paired and connected.
 *
 * Used by the conformance suite to run the extension backend against the same
 * fixtures as the others. Skipped — `available()` is false — when there is no
 * Chromium on this machine or the extension has not been built (`npm run build`).
 *
 * Tests may launch a browser; `src/` may not (only `cdp.ts` imports playwright-core).
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { ExtensionBackend } from '../../src/runtime/browser/extension/backend.js';

const EXTENSION_DIR = resolve(import.meta.dirname, '../../dist/extension');
const TOKEN = 'conformance-test-pairing-token-0123456789';

/**
 * A Chromium to launch: `SNOOPIT_TEST_CHROMIUM`, else the one this playwright-core
 * version expects, else any Chromium installed under `PLAYWRIGHT_BROWSERS_PATH` —
 * the installed build often lags the library, and a silent skip would hide it.
 */
function chromiumPath(): string | null {
  const configured = process.env['SNOOPIT_TEST_CHROMIUM'];
  if (configured !== undefined) return existsSync(configured) ? configured : null;
  try {
    const bundled = chromium.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    /* fall through to the installed builds */
  }
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (root === undefined || !existsSync(root)) return null;
  for (const entry of readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()) {
    for (const platform of ['chrome-linux', 'chrome-linux64']) {
      const candidate = join(root, entry, platform, 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function extensionBrowserAvailable(): boolean {
  return chromiumPath() !== null && existsSync(join(EXTENSION_DIR, 'manifest.json'));
}

export interface ExtensionBrowser {
  /** Opens the endpoint and waits for the extension, as `snoopit tick` does. */
  connect(): Promise<ExtensionBackend>;
  /**
   * Asks the extension to connect now, as saving its options does — for when the
   * endpoint is opened by another process (the CLI) rather than by `connect()`.
   */
  nudge(): Promise<void>;
  close(): Promise<void>;
}

export async function launchExtensionBrowser(port: number): Promise<ExtensionBrowser> {
  const context: BrowserContext = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), 'snoopit-ext-profile-')),
    {
      executablePath: chromiumPath()!,
      headless: false,
      args: [
        '--headless=new',
        '--no-sandbox',
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    },
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;

  // Pair the way a person does: through the options page.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.fill('#token', TOKEN);
  await options.fill('#port', String(port));

  let first = true;
  return {
    async connect() {
      const connecting = ExtensionBackend.connect({
        token: TOKEN,
        port,
        connectTimeoutMs: 20_000,
        defaultTimeoutMs: 10_000,
      });
      if (first) {
        // Saving triggers an immediate connection attempt; later connections come
        // from the extension's own retry loop.
        first = false;
        await options.click('#save');
      }
      return connecting;
    },
    async nudge() {
      first = false;
      await options.click('#save');
    },
    async close() {
      await context.close();
    },
  };
}
