import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/doctor.js';
import { loadConfig } from '../../src/config/load.js';
import { connectBrowser } from '../../src/runtime/browser/connect.js';

function configWith(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'snoopit-backend-'));
  writeFileSync(join(dir, 'snoopit.config.yaml'), yaml);
  return loadConfig({ cwd: dir, env: {} });
}

const EXTENSION = 'browser:\n  backend: extension\n';
const TOKEN = 'f'.repeat(64);

describe('browser.backend', () => {
  it('stays on CDP unless told otherwise', () => {
    const { config } = configWith('');
    expect(config.browser.backend).toBe('cdp');
    expect(config.browser.extension).toEqual({
      port: 9333,
      tokenEnv: 'SNOOPIT_EXTENSION_TOKEN',
      connectTimeout: '45s',
    });
  });

  it('rejects an unknown backend by name', () => {
    expect(() => configWith('browser:\n  backend: firefox\n')).toThrow(/browser\.backend/);
  });

  it('names the missing token variable instead of waiting for an extension in vain', async () => {
    const { config } = configWith(EXTENSION);
    await expect(connectBrowser(config, {})).rejects.toThrow(/SNOOPIT_EXTENSION_TOKEN is not set/);
  });
});

describe('snoopit doctor with the extension backend', () => {
  const check = async (env: NodeJS.ProcessEnv) =>
    (await runDoctor(configWith(EXTENSION), env)).find((c) => c.name === 'extension');

  it('fails without a pairing token', async () => {
    expect(await check({})).toMatchObject({
      status: 'fail',
      detail: 'SNOOPIT_EXTENSION_TOKEN is not set',
    });
  });

  it('fails with a token too short to protect the browser', async () => {
    expect(await check({ SNOOPIT_EXTENSION_TOKEN: 'short' })).toMatchObject({ status: 'fail' });
  });

  it('passes with a proper token, and does not probe a CDP port that is not used', async () => {
    const checks = await runDoctor(configWith(EXTENSION), { SNOOPIT_EXTENSION_TOKEN: TOKEN });
    expect(checks.find((c) => c.name === 'extension')?.status).toBe('ok');
    expect(checks.map((c) => c.name)).not.toContain('chrome');
    expect(checks.map((c) => c.name)).not.toContain('cdp-binding');
  });
});
