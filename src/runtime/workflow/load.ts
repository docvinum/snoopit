/**
 * Finding and loading a workflow module.
 *
 * Workflows are compiled with the project, so loading one is an ordinary dynamic
 * import of a checked module — not an eval, not a plugin registry. A workflow that
 * fails to type-check never reaches a run.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkflowDefinition } from './types.js';

/**
 * Where compiled workflows live, relative to this module.
 *
 * `dist/src/runtime/workflow/load.js` -> `dist/workflows`. Derived from
 * `import.meta.url` rather than the working directory, so the CLI behaves the same
 * whatever directory it is invoked from.
 */
export function defaultWorkflowsDir(): string {
  return resolve(new URL('../../../workflows', import.meta.url).pathname);
}

export function listWorkflows(dir: string = defaultWorkflowsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => extname(file) === '.js')
    .map((file) => basename(file, '.js'))
    .sort();
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { run?: unknown }).run === 'function'
  );
}

/** Loads a workflow by name, failing with the available names when it is unknown. */
export async function loadWorkflow(
  name: string,
  dir: string = defaultWorkflowsDir(),
): Promise<WorkflowDefinition> {
  const file = resolve(dir, `${name}.js`);
  if (!existsSync(file)) {
    const available = listWorkflows(dir);
    throw new Error(
      `Unknown workflow "${name}". Available: ${available.length === 0 ? '(none)' : available.join(', ')}`,
    );
  }

  const module: unknown = await import(pathToFileURL(file).href);
  const exported = (module as { default?: unknown }).default;

  if (!isWorkflowDefinition(exported)) {
    throw new Error(`Workflow "${name}" must export a workflow() definition as its default export`);
  }
  return exported;
}
