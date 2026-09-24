/**
 * Collecting a file: fetch, verify, hash, write.
 *
 * Deliberately backend-agnostic — it takes a `PageHandle` and uses its session, so
 * the same code path collects a public PDF and one behind a login. The artifact row
 * is written by the workflow context (Lot 3); this module's job ends at the bytes
 * being on disk with their provenance known.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { contentHash } from '../../util/hash.js';
import type { PageHandle } from '../browser/types.js';
import { artifactPath } from './paths.js';

export interface DownloadOptions {
  readonly jobId: string;
  /** Root of the data directory; the returned path is relative to it. */
  readonly dataDir: string;
  readonly dir?: string;
  readonly filename?: string;
  readonly timeoutMs?: number;
  /**
   * Refuse a body larger than this, in bytes. The check happens after the transfer,
   * so it guards disk and budget rather than bandwidth.
   */
  readonly maxBytes?: number;
}

export interface DownloadResult {
  /** URL actually fetched, after redirects. */
  readonly url: string;
  readonly canonicalUrl: string;
  readonly status: number;
  readonly mediaType: string | null;
  readonly bytes: number;
  readonly contentHash: string;
  /** Path relative to the data directory, POSIX-separated. */
  readonly path: string;
  readonly absolutePath: string;
}

export class DownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** A verified response, hashed and addressed, but not yet on disk. */
export interface FetchedDownload {
  /** URL actually fetched, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly mediaType: string | null;
  readonly body: Buffer;
  readonly bytes: number;
  readonly contentHash: string;
  /** Default path relative to the data directory, derived from the URL. */
  readonly path: string;
}

/**
 * Fetches `url` through the page's session and checks it, without writing.
 *
 * Split from the write so the caller can decide *where* the bytes go — or that they
 * go nowhere because an identical artifact already exists — before anything on disk
 * is touched.
 *
 * A non-2xx response throws: a 404 body saved as a PDF is worse than no file at
 * all, because nothing downstream would notice.
 */
export async function fetchDownload(
  page: PageHandle,
  url: string,
  options: Omit<DownloadOptions, 'dataDir'>,
): Promise<FetchedDownload> {
  const response = await page.fetch(
    url,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );

  if (response.status < 200 || response.status >= 300) {
    throw new DownloadError(url, response.status, `HTTP ${String(response.status)} for ${url}`);
  }

  const bytes = response.body.byteLength;
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    throw new DownloadError(
      url,
      response.status,
      `Body of ${String(bytes)} bytes exceeds the ${String(options.maxBytes)} byte limit for ${url}`,
    );
  }

  return {
    url: response.url,
    status: response.status,
    mediaType: response.mediaType,
    body: response.body,
    bytes,
    contentHash: contentHash(response.body),
    path: artifactPath({
      jobId: options.jobId,
      canonicalUrl: response.url,
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      ...(options.filename === undefined ? {} : { filename: options.filename }),
    }),
  };
}

/** Writes fetched bytes at a data-dir-relative path, creating directories. */
export async function writeDownload(
  dataDir: string,
  relativePath: string,
  body: Buffer,
): Promise<string> {
  const absolutePath = resolve(dataDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body);
  return absolutePath;
}

/**
 * Fetches `url` through the page's session and writes it at its default path.
 *
 * The plain composition of `fetchDownload` and `writeDownload`. The workflow
 * context does not use it: it must check for an existing artifact in between.
 */
export async function downloadTo(
  page: PageHandle,
  url: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const fetched = await fetchDownload(page, url, options);
  const absolutePath = await writeDownload(options.dataDir, fetched.path, fetched.body);

  return {
    url: fetched.url,
    canonicalUrl: fetched.url,
    status: fetched.status,
    mediaType: fetched.mediaType,
    bytes: fetched.bytes,
    contentHash: fetched.contentHash,
    path: fetched.path,
    absolutePath,
  };
}
