/**
 * One suite, both backends.
 *
 * This is the Lot 2 acceptance criterion made executable: the fake and the real
 * Chrome must answer identically, or the port is a fiction. Where they legitimately
 * differ — the fake has no clock and no layout — the difference is named in the
 * test, never quietly tolerated.
 *
 * The CDP half is skipped when no Chrome is reachable, so CI stays green on a
 * machine without a browser; the fake half always runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpBackend } from '../../src/runtime/browser/cdp.js';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import {
  ElementNotFoundError,
  NotInteractableError,
  type BrowserBackend,
} from '../../src/runtime/browser/types.js';
import { downloadTo } from '../../src/runtime/downloads/download.js';
import {
  extensionBrowserAvailable,
  launchExtensionBrowser,
  type ExtensionBrowser,
} from '../support/extension-browser.js';
import { contentHash } from '../../src/util/hash.js';
import { buildFakeSite } from '../support/fake-site.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDP_URL = process.env['SNOOPIT_TEST_CDP_URL'] ?? 'http://127.0.0.1:9222';

async function chromeAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let server: FixtureServer;
let hasChrome = false;
let extensionBrowser: ExtensionBrowser | null = null;

beforeAll(async () => {
  server = await startFixtureServer();
  hasChrome = await chromeAvailable();
  if (extensionBrowserAvailable()) extensionBrowser = await launchExtensionBrowser(19333);
}, 60_000);

afterAll(async () => {
  await extensionBrowser?.close();
  await server.close();
});

interface Harness {
  readonly name: string;
  /** Every backend is given byte-identical fixture content. */
  create(): Promise<BrowserBackend>;
  /** True when the backend models timing and layout. */
  readonly isReal: boolean;
  /** False when what this backend needs is absent here; its tests are then skipped. */
  available(): boolean;
}

const HARNESSES: Harness[] = [
  {
    name: 'FakeBackend',
    isReal: false,
    available: () => true,
    create: () => Promise.resolve(new FakeBackend(buildFakeSite(server.origin))),
  },
  {
    name: 'CdpBackend',
    isReal: true,
    available: () => hasChrome,
    create: () => CdpBackend.connect({ cdpUrl: CDP_URL, defaultTimeoutMs: 10_000 }),
  },
  {
    // No debugging port: a Chromium a person could see, driven by the extension.
    name: 'ExtensionBackend',
    isReal: true,
    available: () => extensionBrowser !== null,
    create: () => extensionBrowser!.connect(),
  },
];

for (const harness of HARNESSES) {
  describe(harness.name, () => {
    let backend: BrowserBackend;

    beforeAll(async () => {
      if (!harness.available()) return;
      backend = await harness.create();
    }, 30_000);

    afterAll(async () => {
      if (!harness.available()) return;
      await backend.close();
    });

    /** Skips the whole body when this harness needs a Chrome that is not there. */
    const runs = (): boolean => harness.available();

    describe('navigation', () => {
      it('reports the final URL and a 200 status', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const status = page.status();
        expect(status).toBe(200);
        expect(page.url()).toContain('/index.html');
        expect(page.redirectChain()).toEqual([]);
        await page.close();
      });

      it('reports a 404 rather than pretending the page loaded', async () => {
        if (!runs()) return;
        const page = await backend.newPage();
        const result = await page.navigate(server.url('/missing.html'));
        expect(result.status).toBe(404);
        expect(result.ok).toBe(false);
        await page.close();
      });

      it('reports a 500', async () => {
        if (!runs()) return;
        const page = await backend.newPage();
        const result = await page.navigate(server.url('/server-error'));
        expect(result.status).toBe(500);
        expect(result.ok).toBe(false);
        await page.close();
      });

      it('follows a redirect and exposes the chain it took', async () => {
        if (!runs()) return;
        const page = await backend.newPage();
        const result = await page.navigate(server.url('/old-address.html'));

        expect(result.url).toContain('/page-2.html');
        expect(result.status).toBe(200);
        expect(result.redirectChain).toHaveLength(1);
        expect(result.redirectChain[0]).toContain('/old-address.html');
        await page.close();
      });
    });

    describe('waitForReady', () => {
      it('resolves when the expected selector is present', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        await expect(page.waitForReady({ selector: '.publication-list' })).resolves.toBeUndefined();
        await page.close();
      });

      it('rejects when the expected selector never appears', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        // Failure is explicit. A wait that resolves on timeout makes every
        // downstream assertion meaningless — the defect this port exists to avoid.
        await expect(
          page.waitForReady({ selector: '.never-present', timeoutMs: 1000 }),
        ).rejects.toThrow();
        await page.close();
      });
    });

    describe('query', () => {
      it('returns null for a selector that matches nothing', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        expect(await page.query('.no-such-thing')).toBeNull();
        await page.close();
      });

      it('snapshots tag, text and attributes', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const snapshot = await page.query('#next-page');

        expect(snapshot).not.toBeNull();
        expect(snapshot!.tagName).toBe('a');
        expect(snapshot!.text).toBe('Page suivante');
        expect(snapshot!.attributes['id']).toBe('next-page');
        await page.close();
      });

      it('collapses whitespace in text, so formatting does not change the value', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const items = await page.queryAll('.publication .title');
        expect(items[2]!.text).toBe('Note technique');
        await page.close();
      });

      it('returns every match in document order', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const items = await page.queryAll('.publication');
        expect(items).toHaveLength(3);
        await page.close();
      });
    });

    describe('extractAll', () => {
      it('extracts structured records with absolute URLs', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const rows = await page.extractAll({
          selector: '.publication',
          fields: { title: '.title', url: '.title@href', date: '.date', pdf: '.download@href' },
        });

        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({
          title: 'Rapport annuel 2026',
          url: server.url('/publications/rapport-2026.html'),
          date: '2026-03-14',
          pdf: server.url('/publications/rapport-2026.pdf'),
        });
      });

      it('yields null for a missing field instead of throwing', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const rows = await page.extractAll({
          selector: '.publication',
          fields: { pdf: '.download@href' },
        });
        expect(rows[2]!.pdf).toBeNull();
        await page.close();
      });

      it('reads an attribute of the item itself', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const rows = await page.extractAll({
          selector: 'nav a',
          fields: { id: '@id', label: '@text' },
        });
        expect(rows.map((r) => r.id)).toEqual([
          'next-page',
          'broken-link',
          'redirected',
          'external',
        ]);
        expect(rows[0]!.label).toBe('Page suivante');
        await page.close();
      });

      it('returns an empty list when nothing matches', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        expect(await page.extractAll({ selector: '.absent', fields: { a: '@text' } })).toEqual([]);
        await page.close();
      });
    });

    describe('human interactability', () => {
      it.each([
        ['#hidden-display', 'display-none'],
        ['#hidden-visibility', 'visibility-hidden'],
        ['#aria-hidden-button', 'aria-hidden'],
        ['#disabled-button', 'disabled'],
        ['#inert-button', 'inert'],
        ['#no-pointer', 'pointer-events-none'],
      ])('refuses to click %s, reporting %s', async (selector, reason) => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));

        // Not about defeating honeypots: these are simply not part of the
        // interface a person uses, so touching them means we have drifted.
        const error = await page.click(selector, { timeoutMs: 1000 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotInteractableError);
        // Asserting the *reason*, not just the refusal: both backends must reach
        // the same diagnosis through the shared predicate.
        expect((error as NotInteractableError).reasons).toContain(reason);

        // The element exists — it is simply not something a person can act on.
        expect(await page.query(selector)).not.toBeNull();
        await page.close();
      });

      it('clicks an ordinary button', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        await expect(page.click('#real-button')).resolves.toBeUndefined();
        await page.close();
      });

      it('throws ElementNotFoundError for a missing selector', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        await expect(page.click('#nope', { timeoutMs: 1000 })).rejects.toThrow(
          ElementNotFoundError,
        );
        await page.close();
      });

      it('dismisses a cookie banner deterministically, with no LLM involved', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        expect(await page.query('#cookie-banner')).not.toBeNull();

        await page.click('#accept-cookies');

        const banner = await page.query('#cookie-banner');
        expect(banner).not.toBeNull();
        expect(banner!.view.display).toBe('none');
        await page.close();
      });
    });

    describe('content and screenshots', () => {
      it('returns the document HTML', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const html = await page.content();
        expect(html).toContain('publication-list');
        await page.close();
      });

      it('produces a PNG', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const shot = await page.screenshot();
        // PNG magic number: proves real bytes, not a placeholder string.
        expect(shot.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await page.close();
      });
    });

    describe('fetch and download', () => {
      it('fetches a PDF with its media type and exact bytes', async () => {
        if (!runs()) return;
        const page = await backend.open(server.url('/index.html'));
        const result = await page.fetch(server.url('/publications/rapport-2026.pdf'));

        expect(result.status).toBe(200);
        expect(result.mediaType).toBe('application/pdf');
        expect(result.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');

        const onDisk = readFileSync('tests/fixtures/site/publications/rapport-2026.pdf');
        expect(contentHash(result.body)).toBe(contentHash(onDisk));
        await page.close();
      });

      it('writes a download to a deterministic path with provenance', async () => {
        if (!runs()) return;
        const dataDir = mkdtempSync(join(tmpdir(), 'snoopit-dl-'));
        const page = await backend.open(server.url('/index.html'));

        const result = await downloadTo(page, server.url('/publications/etude-marche.pdf'), {
          jobId: 'demo-job',
          dataDir,
          dir: 'publications',
        });

        expect(result.status).toBe(200);
        expect(result.mediaType).toBe('application/pdf');
        expect(result.path).toMatch(
          /^jobs\/demo-job\/artifacts\/publications\/etude-marche-[0-9a-f]{6}\.pdf$/,
        );
        expect(result.contentHash).toBe(
          contentHash(readFileSync('tests/fixtures/site/publications/etude-marche.pdf')),
        );
        expect(contentHash(readFileSync(result.absolutePath))).toBe(result.contentHash);
        await page.close();
      });

      it('refuses to save a non-2xx body', async () => {
        if (!runs()) return;
        const dataDir = mkdtempSync(join(tmpdir(), 'snoopit-dl-'));
        const page = await backend.open(server.url('/index.html'));
        // A 404 page saved as a PDF is worse than no file: nothing downstream notices.
        await expect(
          downloadTo(page, server.url('/publications/absent.pdf'), { jobId: 'j', dataDir }),
        ).rejects.toThrow(/HTTP 404/);
        await page.close();
      });

      it('is deterministic: the same URL yields the same path twice', async () => {
        if (!runs()) return;
        const dataDir = mkdtempSync(join(tmpdir(), 'snoopit-dl-'));
        const page = await backend.open(server.url('/index.html'));
        const url = server.url('/publications/bilan-2025.pdf');

        const first = await downloadTo(page, url, { jobId: 'j', dataDir });
        const second = await downloadTo(page, url, { jobId: 'j', dataDir });

        expect(second.path).toBe(first.path);
        expect(second.contentHash).toBe(first.contentHash);
        await page.close();
      });
    });
  });
}

describe('backend coverage', () => {
  it('reports whether the real Chrome half ran', () => {
    // Visible in the output rather than silently skipped, so a green CI run never
    // hides the fact that only the fake was exercised.
    console.error(
      hasChrome
        ? `[conformance] CdpBackend exercised against ${CDP_URL}`
        : `[conformance] no Chrome at ${CDP_URL} — CdpBackend half skipped`,
    );
    expect(typeof hasChrome).toBe('boolean');
  });

  it('reports whether the extension half ran', () => {
    console.error(
      extensionBrowser === null
        ? '[conformance] no Chromium or no built extension — ExtensionBackend half skipped'
        : '[conformance] ExtensionBackend exercised in Chromium, extension loaded, no debug port',
    );
    expect(typeof extensionBrowserAvailable()).toBe('boolean');
  });
});
