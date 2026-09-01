import { randomBytes } from 'node:crypto';

/** Lowercase, dash-separated identifier derived from a human name. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') throw new Error(`slugify: "${input}" produced an empty slug`);
  return slug;
}

/** Job ids are readable slugs: they appear in `data/jobs/<id>/` on disk. */
export function jobId(name: string): string {
  return slugify(name);
}

/**
 * Run ids double as run directory names, so they are sortable and readable:
 * `2026-08-31T080000Z-3f9a`. The random suffix keeps two runs started in the same
 * second from colliding.
 */
export function runId(at: Date = new Date()): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}
