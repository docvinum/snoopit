import { createHash } from 'node:crypto';

/**
 * Content hash used to answer "did this change since we last saw it?".
 *
 * sha256, hex, prefixed with the algorithm so the column stays readable and a future
 * algorithm change does not silently compare against old values.
 */
export function contentHash(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}
