/**
 * Loading a workflow is an ordinary import of a compiled, type-checked module —
 * not an eval and not a plugin registry. These tests pin that contract.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listWorkflows, loadWorkflow } from '../../src/runtime/workflow/load.js';
import { workflow } from '../../src/runtime/workflow/types.js';

function withWorkflowDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'snoopit-wf-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

const VALID = `export default { name: 'demo', run: async () => ({ ok: true }) };`;

describe('workflow()', () => {
  it('returns the definition unchanged', () => {
    const definition = { name: 'x', run: () => Promise.resolve(1) };
    expect(workflow(definition)).toBe(definition);
  });

  it('refuses a nameless workflow', () => {
    expect(() => workflow({ name: '  ', run: () => Promise.resolve(1) })).toThrow(/name/);
  });
});

describe('listWorkflows', () => {
  it('lists compiled workflow names, sorted', () => {
    const dir = withWorkflowDir({
      'b.js': VALID,
      'a.js': VALID,
      'a.d.ts': 'export {};',
      'notes.md': '# ignored',
    });
    expect(listWorkflows(dir)).toEqual(['a', 'b']);
  });

  it('returns an empty list for a missing directory', () => {
    expect(listWorkflows('/nope/does/not/exist')).toEqual([]);
  });
});

describe('loadWorkflow', () => {
  it('loads a default-exported definition', async () => {
    const dir = withWorkflowDir({ 'demo.js': VALID });
    const definition = await loadWorkflow('demo', dir);
    expect(definition.name).toBe('demo');
    expect(typeof definition.run).toBe('function');
  });

  it('names the available workflows when one is unknown', async () => {
    const dir = withWorkflowDir({ 'demo.js': VALID, 'other.js': VALID });
    await expect(loadWorkflow('absent', dir)).rejects.toThrow(/Available: demo, other/);
  });

  it('says so when there are no workflows at all', async () => {
    await expect(loadWorkflow('anything', withWorkflowDir({}))).rejects.toThrow(/\(none\)/);
  });

  it('rejects a module that does not export a workflow', async () => {
    const dir = withWorkflowDir({ 'bad.js': `export default { nope: true };` });
    await expect(loadWorkflow('bad', dir)).rejects.toThrow(/default export/);
  });

  it('rejects a module with no default export', async () => {
    const dir = withWorkflowDir({ 'bare.js': `export const something = 1;` });
    await expect(loadWorkflow('bare', dir)).rejects.toThrow(/default export/);
  });
});
