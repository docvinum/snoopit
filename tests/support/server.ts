/**
 * A static server for the fixture site.
 *
 * Local only, on an ephemeral port: no CI test ever touches a third-party site
 * (spec §19). It serves a few deliberate hazards — a 404, a 302, a slow endpoint —
 * because those are the conditions an `audit` workflow exists to detect.
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(fileURLToPath(new URL('../fixtures/site', import.meta.url)));

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export interface FixtureServer {
  readonly origin: string;
  url(path: string): string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(requestUrl.pathname);

    // A permanent redirect, for `unexpected_redirect` checks.
    if (pathname === '/old-address.html') {
      res.writeHead(302, { location: '/page-2.html' });
      res.end();
      return;
    }

    // Never completes within a test's patience: proves a timeout throws.
    if (pathname === '/slow') {
      return;
    }

    if (pathname === '/server-error') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }

    const relative = pathname === '/' ? '/index.html' : pathname;
    // Contain the path inside the fixture root: a traversal must 404, not read /etc.
    const target = resolve(join(SITE_ROOT, normalize(relative)));
    if (target !== SITE_ROOT && !target.startsWith(SITE_ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    void readFile(target).then(
      (body) => {
        res.writeHead(200, {
          'content-type': MEDIA_TYPES[extname(target)] ?? 'application/octet-stream',
          'content-length': String(body.byteLength),
        });
        res.end(body);
      },
      () => {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>404</h1></body></html>');
      },
    );
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a port');
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;

  return {
    origin,
    url: (path: string) => new URL(path, origin).href,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      }),
  };
}
