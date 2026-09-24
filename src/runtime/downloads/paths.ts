/**
 * Where a collected file goes on disk.
 *
 * Pure and deterministic: the same URL always yields the same path, so a re-run
 * overwrites its own file instead of accumulating `report(1).pdf`. Two *different*
 * URLs that happen to share a basename get different paths, because the canonical
 * URL contributes a short digest.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** Characters that are unsafe in a filename on any of our target platforms. */
const UNSAFE = /[^a-zA-Z0-9._-]+/g;
const MAX_BASENAME_LENGTH = 80;

export interface ArtifactPathInput {
  readonly jobId: string;
  /** Canonical URL of the resource. Contributes the disambiguating digest. */
  readonly canonicalUrl: string;
  /** Sub-directory under the job's artifacts, e.g. `publications/`. */
  readonly dir?: string;
  /** Explicit filename. When given, only sanitising is applied. */
  readonly filename?: string;
}

/** Short, stable digest of a URL. Six hex characters is plenty to separate names. */
function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

/**
 * Reduces one path segment to safe characters.
 *
 * Dots are legal in filenames but runs of them are not: `..` is a traversal token
 * on every platform, and a segment of `.` or `..` would address a directory rather
 * than a file. Collapsing dot-runs and trimming leading and trailing separators
 * means no input can produce either, whatever it contained.
 */
function sanitizeSegment(segment: string): string {
  const cleaned = segment
    .replace(UNSAFE, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.slice(0, MAX_BASENAME_LENGTH);
}

/**
 * Sanitises a caller-supplied directory.
 *
 * `..` segments and absolute paths are dropped rather than escaped, because a
 * workflow — possibly written by a coding agent from a page's own content — must
 * never be able to address a location outside its job's artifact directory.
 */
export function sanitizeDir(dir: string): string {
  return dir
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map(sanitizeSegment)
    .filter((segment) => segment !== '')
    .join('/');
}

/** Derives a filename from a URL's last path segment, falling back to `index`. */
export function filenameFromUrl(canonicalUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(canonicalUrl).pathname;
  } catch {
    pathname = canonicalUrl;
  }
  const last =
    pathname
      .split('/')
      .filter((s) => s !== '')
      .pop() ?? '';
  const sanitized = sanitizeSegment(decodeURIComponent(last));
  return sanitized === '' ? 'index' : sanitized;
}

/**
 * Path of an artifact, relative to the data directory.
 *
 * Always POSIX-separated: it is stored in SQLite and must mean the same thing on
 * every machine that later reads the database.
 */
export function artifactPath(input: ArtifactPathInput): string {
  const base =
    input.filename === undefined
      ? filenameFromUrl(input.canonicalUrl)
      : sanitizeSegment(input.filename);

  const extension = posix.extname(base);
  const stem = extension === '' ? base : base.slice(0, -extension.length);
  const named = `${stem}-${shortDigest(input.canonicalUrl)}${extension}`;

  const dir = input.dir === undefined ? '' : sanitizeDir(input.dir);
  return posix.join('jobs', sanitizeSegment(input.jobId), 'artifacts', dir, named);
}

/**
 * The path for a *new version* of a file already stored at `path`.
 *
 * A document republished at the same URL with different bytes must not overwrite
 * the earlier file: its artifact row still carries the old hash, and provenance
 * that no longer matches the bytes on disk is worse than none. The version is
 * named by its own content, so it stays deterministic — collecting the same bytes
 * twice still lands on the same file.
 */
export function versionedPath(path: string, contentHash: string): string {
  const version = contentHash.replace(/^[a-z0-9]+:/, '').slice(0, 8);
  const extension = posix.extname(path);
  const stem = extension === '' ? path : path.slice(0, -extension.length);
  return `${stem}.${version}${extension}`;
}

/** Directory holding one run's outputs, relative to the data directory. */
export function runDir(jobId: string, runId: string): string {
  return posix.join('jobs', sanitizeSegment(jobId), 'runs', sanitizeSegment(runId));
}
