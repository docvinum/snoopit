/**
 * Builds a `FakeSite` from the same fixture files the HTTP server serves.
 *
 * This is what makes the conformance suite meaningful: both backends see byte-identical
 * content, so a difference in a test result is a difference in the *backends*, never
 * in the fixtures they were given.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeUrl } from '../../src/runtime/navigation/canonical.js';
import type { FakeResponse, FakeSite } from '../../src/runtime/browser/fake.js';

const SITE_ROOT = resolve(fileURLToPath(new URL('../fixtures/site', import.meta.url)));

function read(path: string): Buffer {
  return readFileSync(resolve(SITE_ROOT, path));
}

/**
 * Mirrors the fixture server's routing table, including its deliberate hazards.
 *
 * Route keys are produced by `canonicalizeUrl` rather than written by hand, because
 * the fake looks routes up by canonical URL. Hand-written keys silently 404 the
 * moment a canonicalisation rule changes; derived ones cannot drift.
 */
export function buildFakeSite(origin = 'http://127.0.0.1:9999'): FakeSite {
  const routes: Record<string, FakeResponse> = {};

  const at = (path: string, response: FakeResponse): void => {
    const canonical = canonicalizeUrl(path, { base: origin });
    if (!canonical.ok) throw new Error(`Unusable fixture route: ${path}`);
    routes[canonical.canonical] = response;
  };

  const html = (path: string): FakeResponse => ({
    status: 200,
    body: read(path).toString('utf8'),
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const pdf = (path: string): FakeResponse => ({
    status: 200,
    body: read(path),
    headers: { 'content-type': 'application/pdf' },
  });

  at('/index.html', html('index.html'));
  at('/page-2.html', html('page-2.html'));
  at('/publications/rapport-2026.html', html('publications/rapport-2026.html'));
  at('/publications/etude-marche.html', html('publications/etude-marche.html'));
  at('/publications/note-technique.html', html('publications/note-technique.html'));
  at('/publications/bilan-2025.html', html('publications/bilan-2025.html'));
  at('/publications/rapport-2026.pdf', pdf('publications/rapport-2026.pdf'));
  at('/publications/etude-marche.pdf', pdf('publications/etude-marche.pdf'));
  at('/publications/bilan-2025.pdf', pdf('publications/bilan-2025.pdf'));
  at('/assets/logo.png', {
    status: 200,
    body: read('assets/logo.png'),
    headers: { 'content-type': 'image/png' },
  });
  at('/old-address.html', { redirectTo: `${origin}/page-2.html` });
  at('/server-error', { status: 500, body: 'boom' });

  return { routes };
}
