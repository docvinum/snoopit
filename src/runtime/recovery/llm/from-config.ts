/**
 * Building the recovery provider from configuration.
 *
 * Returns `null` when no key is available, and that is a supported state rather
 * than an error: a nominal run makes no model call, so a missing key must never
 * prevent a crawl from starting. Recovery then stops at L1, which handles the
 * overwhelming majority of surprises anyway.
 */

import type { Config } from '../../../config/schema.js';
import { llmApiKey } from '../../../config/load.js';
import { OpenAiCompatibleProvider, openRouterHeaders } from './openai-compatible.js';
import type { LlmProvider } from './provider.js';

export interface ProviderFromConfigResult {
  readonly provider: LlmProvider | null;
  /** Why there is no provider, when there is none. Surfaced in the run log. */
  readonly reason: string | null;
}

export function providerFromConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ProviderFromConfigResult {
  const key = llmApiKey(config, env);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(config.llm.baseUrl);

  if (key === null && !isLocal) {
    return {
      provider: null,
      reason: `no API key in ${config.llm.apiKeyEnv} — recovery will stop at L1`,
    };
  }

  return {
    provider: new OpenAiCompatibleProvider({
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      apiKey: key,
      ...(config.llm.provider === 'openrouter' ? { headers: openRouterHeaders() } : {}),
    }),
    reason: null,
  };
}
