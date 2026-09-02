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
   * so it guards disk and budget rather than bandwidth; a streaming guard belongs
   * with the byte budget in Lot 4.
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

/**
 * Fetches `url` through the page's session and writes it under the job's artifacts.
 *
 * A non-2xx response throws instead of writing: a 404 body saved as a PDF is worse
 * than no file at all, because nothing downstream would notice.
 */
export async function downloadTo(
  page: PageHandle,
  url: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
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

  const relativePath = artifactPath({
    jobId: options.jobId,
    canonicalUrl: response.url,
    ...(options.dir === undefined ? {} : { dir: options.dir }),
    ...(options.filename === undefined ? {} : { filename: options.filename }),
  });
  const absolutePath = resolve(options.dataDir, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, response.body);

  return {
    url: response.url,
    canonicalUrl: response.url,
    status: response.status,
    mediaType: response.mediaType,
    bytes,
    contentHash: contentHash(response.body),
    path: relativePath,
    absolutePath,
  };
}
