/**
 * Choosing and connecting the browser backend a run will use, from the config.
 *
 * The one place that knows both real backends exist; the CLI asks for "the
 * browser" and gets whichever `browser.backend` names.
 */

import type { Config } from '../../config/schema.js';
import { parseDuration } from '../../util/time.js';
import { CdpBackend } from './cdp.js';
import { ExtensionBackend } from './extension/backend.js';
import type { BrowserBackend } from './types.js';

export async function connectBrowser(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrowserBackend> {
  const defaultTimeoutMs = parseDuration(config.browser.navigationTimeout);

  if (config.browser.backend === 'cdp') {
    return CdpBackend.connect({ cdpUrl: config.browser.cdpUrl, defaultTimeoutMs });
  }

  const { port, tokenEnv, connectTimeout } = config.browser.extension;
  const token = env[tokenEnv];
  if (token === undefined || token === '') {
    throw new Error(
      `browser.backend is "extension" but ${tokenEnv} is not set — ` +
        'generate a token (openssl rand -hex 32), set it there and in the extension options',
    );
  }
  return ExtensionBackend.connect({
    token,
    port,
    connectTimeoutMs: parseDuration(connectTimeout),
    defaultTimeoutMs,
  });
}
