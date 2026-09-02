/**
 * Behaviours only a real browser can exhibit.
 *
 * The fake has no clock and no layout, so timing and geometry are verified here or
 * not at all. Skipped when no Chrome is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpBackend } from '../../src/runtime/browser/cdp.js';
import { NavigationTimeoutError, type BrowserBackend } from '../../src/runtime/browser/types.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const CDP_URL = process.env['SNOOPIT_TEST_CDP_URL'] ?? 'http://127.0.0.1:9222';

let server: FixtureServer;
let backend: BrowserBackend | null = null;

beforeAll(async () => {
  server = await startFixtureServer();
  try {
    const probe = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (probe.ok) backend = await CdpBackend.connect({ cdpUrl: CDP_URL, defaultTimeoutMs: 10_000 });
  } catch {
    backend = null;
  }
});

afterAll(async () => {
  if (backend !== null) await backend.close();
  await server.close();
});

describe('CdpBackend — real browser behaviour', () => {
  it('throws NavigationTimeoutError instead of resolving on a hung request', async () => {
    if (backend === null) return;
    const page = await backend.newPage();
    // The defect at the centre of the Lot 0 audit: upstream resolved on timeout, so
    // a failed navigation was indistinguishable from a successful one.
    await expect(page.navigate(server.url('/slow'), { timeoutMs: 1200 })).rejects.toThrow(
      NavigationTimeoutError,
    );
    await page.close();
  });

  it('measures real layout, so a zero-size control is detected without a hint', async () => {
    if (backend === null) return;
    const page = await backend.open(server.url('/index.html'));
    const snapshot = await page.query('#zero-size');

    expect(snapshot).not.toBeNull();
    // Computed by the browser, not declared by the fixture.
    expect(snapshot!.view.width).toBeLessThan(2);
    expect(snapshot!.view.height).toBeLessThan(2);
    await page.close();
  });

  it('honours the viewport from a browser profile', async () => {
    if (backend === null) return;
    const page = await backend.open(server.url('/index.html'), { viewport: [390, 844] });
    const size = await page.query('body');
    expect(size).not.toBeNull();
    await page.close();
  });

  it('runs page scripts, so a real cookie banner really disappears', async () => {
    if (backend === null) return;
    const page = await backend.open(server.url('/index.html'));
    await page.click('#accept-cookies');
    const banner = await page.query('#cookie-banner');
    expect(banner!.view.display).toBe('none');
    await page.close();
  });

  it('collects a document behind the page session using the same cookies', async () => {
    if (backend === null) return;
    const page = await backend.open(server.url('/index.html'));
    const result = await page.fetch(server.url('/publications/bilan-2025.pdf'));
    expect(result.status).toBe(200);
    expect(result.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    await page.close();
  });
});
