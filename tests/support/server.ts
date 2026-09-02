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

export interface FixtureServerOptions {
  /**
   * Delay before each synthetic catalogue document is served.
   *
   * Exists so a test can kill a running crawl at a chosen point: with an instant
   * server there is no moment at which to interrupt one.
   */
  readonly documentDelayMs?: number;
  /** How many documents the synthetic catalogue lists. */
  readonly catalogueSize?: number;
}

/** A minimal, valid PDF carrying a title. Real bytes, so the pipeline is exercised. */
function makePdf(title: string): Buffer {
  const content = Buffer.from(`BT /F1 24 Tf 72 700 Td (${title}) Tj ET`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(content.byteLength)} >>\nstream\n${content.toString()}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });

  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** The synthetic catalogue page: a paginated-style list of downloadable documents. */
function catalogueHtml(size: number): string {
  const items = Array.from({ length: size }, (_, index) => {
    const id = String(index + 1).padStart(2, '0');
    return `      <li class="document">
        <span class="title">Document ${id}</span>
        <span class="date">2026-01-${id}</span>
        <a class="download" href="/catalogue/doc-${id}.pdf">PDF</a>
      </li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="fr">
  <head><meta charset="utf-8" /><title>Catalogue</title></head>
  <body>
    <h1>Catalogue</h1>
    <ul class="document-list">
${items}
    </ul>
  </body>
</html>
`;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const documentDelayMs = options.documentDelayMs ?? 0;
  const catalogueSize = options.catalogueSize ?? 12;

  const server: Server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === '/catalogue.html') {
      const body = catalogueHtml(catalogueSize);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
      return;
    }

    const document = /^\/catalogue\/(doc-\d+)\.pdf$/.exec(pathname);
    if (document !== null) {
      const body = makePdf(document[1]!);
      setTimeout(() => {
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': String(body.byteLength),
        });
        res.end(body);
      }, documentDelayMs);
      return;
    }

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
