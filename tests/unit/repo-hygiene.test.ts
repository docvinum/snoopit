/**
 * A guard against source files silently leaving the repository.
 *
 * This exists because it happened. The `.gitignore` inherited from a Python
 * template carried an unanchored `downloads/` pattern — meant for pip's cache — and
 * it matched `src/runtime/downloads/`. The module was imported by the runner, the
 * workflow context and two test suites, existed on every developer's disk, and was
 * absent from every commit for five lots. Locally everything passed; CI had been red
 * since the module was written.
 *
 * The failure mode is nasty precisely because it is invisible: `git status` says
 * clean, tests pass, and nothing points at the cause. So it gets a mechanical check
 * rather than a note in a document.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Directories whose entire contents must be committed. */
const SOURCE_DIRS = ['src', 'tests', 'workflows', 'profiles', 'docs', 'deploy', 'skills'];

function listFiles(dir: string): string[] {
  const absolute = join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return []; // Directory does not exist yet; nothing to check.
  }

  return entries.flatMap((entry) => {
    const path = join(absolute, entry);
    return statSync(path).isDirectory()
      ? listFiles(relative(REPO_ROOT, path))
      : [relative(REPO_ROOT, path)];
  });
}

/** Files git would refuse to track, among those given. */
function ignoredAmong(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  try {
    // `check-ignore` exits 1 when nothing matches, which is the success case here.
    const output = execFileSync('git', ['check-ignore', '--stdin', '--no-index'], {
      cwd: REPO_ROOT,
      input: paths.join('\n'),
      encoding: 'utf8',
    });
    return output.split('\n').filter((line) => line !== '');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
}

describe('repository hygiene', () => {
  it('keeps every source file trackable by git', () => {
    const files = SOURCE_DIRS.flatMap((dir) => listFiles(dir));
    expect(files.length).toBeGreaterThan(0);

    const ignored = ignoredAmong(files);
    expect(
      ignored,
      `These files are ignored by .gitignore and would never be committed:\n  ${ignored.join('\n  ')}`,
    ).toEqual([]);
  });

  it('anchors the directory patterns that could match a nested source directory', () => {
    // `downloads/` matches at any depth; `/downloads/` matches only at the root.
    // The working tree is what is checked: the guard must hold before the commit
    // that would otherwise ship the mistake.
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8').split('\n');

    const risky = ['build/', 'lib/', 'lib64/', 'dist/', 'var/', 'parts/', 'target/', 'env/'];
    const unanchored = gitignore.map((line) => line.trim()).filter((line) => risky.includes(line));

    expect(
      unanchored,
      `Unanchored patterns match at any depth and can swallow a source directory: ${unanchored.join(', ')}`,
    ).toEqual([]);
  });

  it('points the npm `snoopit` script at the same entry point as `bin`', () => {
    // tsc emits `src/cli/main.ts` to `dist/src/cli/main.js`; a script pointing at
    // `dist/cli/main.js` builds, then fails with a module-not-found error.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    const entry = pkg.bin['snoopit']!.replace(/^\.\//, '');
    expect(pkg.scripts['snoopit']).toContain(`node ${entry}`);
  });
});
