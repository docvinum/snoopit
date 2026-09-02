import { describe, expect, it } from 'vitest';
import {
  artifactPath,
  filenameFromUrl,
  runDir,
  sanitizeDir,
} from '../../src/runtime/downloads/paths.js';

describe('filenameFromUrl', () => {
  it('takes the last path segment', () => {
    expect(filenameFromUrl('https://e.com/pub/rapport-2026.pdf')).toBe('rapport-2026.pdf');
  });

  it('falls back to index for a root URL', () => {
    expect(filenameFromUrl('https://e.com/')).toBe('index');
    expect(filenameFromUrl('https://e.com')).toBe('index');
  });

  it('decodes percent-encoding and sanitises the result', () => {
    expect(filenameFromUrl('https://e.com/rapport%20final.pdf')).toBe('rapport-final.pdf');
  });

  it('strips characters that are unsafe in a filename', () => {
    expect(filenameFromUrl('https://e.com/a:b*c.pdf')).toBe('a-b-c.pdf');
  });

  it('ignores the query string, which is not part of the path', () => {
    expect(filenameFromUrl('https://e.com/report.pdf?v=2')).toBe('report.pdf');
  });

  it('never yields a bare dot segment', () => {
    // `.` or `..` as a filename would address a directory, not a file.
    expect(filenameFromUrl('https://e.com/..')).toBe('index');
    expect(filenameFromUrl('https://e.com/.')).toBe('index');
  });
});

describe('sanitizeDir', () => {
  it('keeps a normal nested directory', () => {
    expect(sanitizeDir('publications/2026')).toBe('publications/2026');
  });

  it('drops traversal segments rather than escaping them', () => {
    // A workflow may be generated from a page's own content; it must never be able
    // to address anything outside its job's artifact directory.
    expect(sanitizeDir('../../etc')).toBe('etc');
    expect(sanitizeDir('a/../../../b')).toBe('a/b');
    expect(sanitizeDir('/absolute/path')).toBe('absolute/path');
    expect(sanitizeDir('./a/./b')).toBe('a/b');
  });

  it('collapses empty segments', () => {
    expect(sanitizeDir('a//b///c')).toBe('a/b/c');
  });

  it('returns an empty string for a directory made only of traversal', () => {
    expect(sanitizeDir('../..')).toBe('');
  });
});

describe('artifactPath', () => {
  it('places a file under its job with a disambiguating digest', () => {
    const path = artifactPath({
      jobId: 'demo-job',
      canonicalUrl: 'https://e.com/pub/rapport.pdf',
      dir: 'publications',
    });
    expect(path).toMatch(/^jobs\/demo-job\/artifacts\/publications\/rapport-[0-9a-f]{6}\.pdf$/);
  });

  it('is deterministic — a re-run overwrites its own file', () => {
    const input = { jobId: 'j', canonicalUrl: 'https://e.com/a/report.pdf' };
    expect(artifactPath(input)).toBe(artifactPath(input));
  });

  it('separates different URLs that share a basename', () => {
    const a = artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/2025/report.pdf' });
    const b = artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/2026/report.pdf' });
    expect(a).not.toBe(b);
    expect(a).toContain('report-');
    expect(b).toContain('report-');
  });

  it('honours an explicit filename', () => {
    expect(
      artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/x', filename: 'bilan.pdf' }),
    ).toMatch(/\/bilan-[0-9a-f]{6}\.pdf$/);
  });

  it('cannot escape the job directory', () => {
    const path = artifactPath({
      jobId: 'j',
      canonicalUrl: 'https://e.com/x.pdf',
      dir: '../../../../etc',
      filename: '../../passwd',
    });
    expect(path.startsWith('jobs/j/artifacts/')).toBe(true);
    expect(path).not.toContain('..');
    expect(path.split('/').every((segment) => segment !== '.' && segment !== '..')).toBe(true);
  });

  it('handles a URL with no extension', () => {
    const path = artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/data' });
    expect(path).toMatch(/^jobs\/j\/artifacts\/data-[0-9a-f]{6}$/);
  });

  it('uses POSIX separators, so the stored path means the same on any machine', () => {
    expect(artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/a.pdf', dir: 'x/y' })).toContain(
      '/',
    );
    expect(artifactPath({ jobId: 'j', canonicalUrl: 'https://e.com/a.pdf' })).not.toContain('\\');
  });
});

describe('runDir', () => {
  it('lays out a run under its job', () => {
    expect(runDir('demo-job', '2026-08-31T080000Z-3f9a')).toBe(
      'jobs/demo-job/runs/2026-08-31T080000Z-3f9a',
    );
  });
});
