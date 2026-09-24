/**
 * Assembles the loadable extension in `dist/extension/` from what
 * `tsc -p extension/tsconfig.json` compiled into `dist/.extension-build/`.
 *
 * Two shared files come from `src/`, and neither can be loaded as compiled:
 *
 *  - `protocol.js` is an ES module: copied to `lib/`, and the imports of the
 *    extension's own modules are rewritten to point there;
 *  - `page-functions.js` is injected into pages with `chrome.scripting`, which
 *    takes classic scripts only: its `export`s are stripped and the functions are
 *    published on `globalThis.__snoopit`, in the page's isolated world.
 *
 * Deliberately a few string rewrites rather than a bundler: the two shared files
 * import nothing at runtime, which `tests/unit/extension-build.test.ts` enforces.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'dist/.extension-build');
const OUT = join(ROOT, 'dist/extension');
const SHARED_IMPORT = '../../src/runtime/browser/extension/protocol.js';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'lib'), { recursive: true });

cpSync(join(ROOT, 'extension/manifest.json'), join(OUT, 'manifest.json'));
cpSync(join(ROOT, 'extension/src/options.html'), join(OUT, 'options.html'));

for (const name of ['background.js', 'options.js']) {
  const source = readFileSync(join(BUILD, 'extension/src', name), 'utf8');
  if (!source.includes(SHARED_IMPORT))
    throw new Error(`${name}: expected import of ${SHARED_IMPORT}`);
  writeFileSync(join(OUT, name), source.replaceAll(SHARED_IMPORT, './lib/protocol.js'));
}

cpSync(join(BUILD, 'src/runtime/browser/extension/protocol.js'), join(OUT, 'lib/protocol.js'));

const pageSource = readFileSync(join(BUILD, 'src/runtime/browser/page-functions.js'), 'utf8');
if (/^\s*import\s/m.test(pageSource)) throw new Error('page-functions.js must not import anything');
const names = [...pageSource.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
const classic = pageSource
  .replace(/^export (async )?function /gm, '$1function ')
  .replace(/^export \{\};?$/gm, '');
writeFileSync(
  join(OUT, 'lib/page-functions.js'),
  `(() => {\n${classic}\nglobalThis.__snoopit = { ${names.join(', ')} };\n})();\n`,
);

// Intermediate output only; what ships is dist/extension.
rmSync(BUILD, { recursive: true, force: true });

console.error(`extension assembled in ${OUT} (${String(names.length)} page functions)`);
