import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

function withConfigFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'snoopit-config-'));
  writeFileSync(join(dir, 'snoopit.config.yaml'), contents);
  return dir;
}

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('loadConfig', () => {
  it('works with no config file at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snoopit-empty-'));
    const { config, sourcePath, paths } = loadConfig({ cwd: dir, env: EMPTY_ENV });

    expect(sourcePath).toBeNull();
    expect(config.browser.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(paths.databaseFile).toBe(resolve(dir, 'data', 'snoopit.db'));
    expect(paths.jobsDir).toBe(resolve(dir, 'data', 'jobs'));
  });

  it('reads a config file and merges it over the defaults', () => {
    const dir = withConfigFile(`
dataDir: ./var
browser:
  cdpUrl: http://127.0.0.1:9333
`);
    const { config, sourcePath, paths } = loadConfig({ cwd: dir, env: EMPTY_ENV });

    expect(sourcePath).toBe(resolve(dir, 'snoopit.config.yaml'));
    expect(config.browser.cdpUrl).toBe('http://127.0.0.1:9333');
    expect(config.browser.defaultProfile).toBe('desktop-chrome');
    expect(paths.dataDir).toBe(resolve(dir, 'var'));
    expect(paths.databaseFile).toBe(resolve(dir, 'var', 'snoopit.db'));
  });

  it('accepts an empty YAML document', () => {
    const dir = withConfigFile('# nothing here\n');
    expect(loadConfig({ cwd: dir, env: EMPTY_ENV }).config.dataDir).toBe('./data');
  });

  it('lets the environment override the file — deployment beats the repo', () => {
    const dir = withConfigFile('dataDir: ./var\nbrowser:\n  cdpUrl: http://127.0.0.1:9333\n');
    const { config, paths } = loadConfig({
      cwd: dir,
      env: { SNOOPIT_DATA_DIR: '/srv/snoopit', SNOOPIT_CDP_URL: 'http://127.0.0.1:9444' },
    });
    expect(paths.dataDir).toBe('/srv/snoopit');
    expect(config.browser.cdpUrl).toBe('http://127.0.0.1:9444');
  });

  it('honours an absolute database path outside the data dir', () => {
    const dir = withConfigFile('database:\n  path: /var/lib/snoopit/state.db\n');
    expect(loadConfig({ cwd: dir, env: EMPTY_ENV }).paths.databaseFile).toBe(
      '/var/lib/snoopit/state.db',
    );
  });

  it('rejects an unknown key instead of silently ignoring it', () => {
    const dir = withConfigFile('dtaDir: ./typo\n');
    expect(() => loadConfig({ cwd: dir, env: EMPTY_ENV })).toThrow(/Invalid configuration/);
  });

  it('ignores legacy local-model settings during an upgrade', () => {
    const dir = withConfigFile(`
llm:
  apiKeyEnv: SNOOPIT_LLM_API_KEY
  model: old-model
defaultBudget:
  maxPages: 12
  maxLlmCalls: 3
`);
    const { config } = loadConfig({ cwd: dir, env: EMPTY_ENV });
    expect(config.defaultBudget).toEqual({ maxPages: 12 });
  });

  it('names the offending field on a validation failure', () => {
    const dir = withConfigFile('browser:\n  cdpUrl: not-a-url\n');
    expect(() => loadConfig({ cwd: dir, env: EMPTY_ENV })).toThrow(/browser\.cdpUrl/);
  });

  it('rejects a malformed duration in the default budget', () => {
    const dir = withConfigFile('defaultBudget:\n  maxDuration: twenty minutes\n');
    expect(() => loadConfig({ cwd: dir, env: EMPTY_ENV })).toThrow(/maxDuration/);
  });

  it('reads schedule windows in UTC unless told otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snoopit-empty-'));
    expect(loadConfig({ cwd: dir, env: EMPTY_ENV }).config.scheduler.timeZone).toBe('UTC');

    const paris = withConfigFile('scheduler:\n  timeZone: Europe/Paris\n');
    expect(loadConfig({ cwd: paris, env: EMPTY_ENV }).config.scheduler.timeZone).toBe(
      'Europe/Paris',
    );
  });

  it('rejects a time zone the platform does not know', () => {
    const dir = withConfigFile('scheduler:\n  timeZone: Europe/Pariss\n');
    expect(() => loadConfig({ cwd: dir, env: EMPTY_ENV })).toThrow(/scheduler\.timeZone/);
  });

  it('rejects a config file that is not a mapping', () => {
    const dir = withConfigFile('- a\n- b\n');
    expect(() => loadConfig({ cwd: dir, env: EMPTY_ENV })).toThrow(/mapping/);
  });

  it('fails loudly when an explicitly requested file is missing', () => {
    expect(() => loadConfig({ file: '/nope/snoopit.config.yaml', env: EMPTY_ENV })).toThrow(
      /not found/,
    );
  });

  it('ships a default budget so a workflow without one is still bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snoopit-budget-'));
    const { config } = loadConfig({ cwd: dir, env: EMPTY_ENV });
    expect(config.defaultBudget.maxPages).toBe(100);
  });
});
