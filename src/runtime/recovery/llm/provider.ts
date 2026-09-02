/**
 * The LLM port.
 *
 * The business layer never names a vendor (spec §6). OpenRouter is the first
 * adapter, any OpenAI-compatible endpoint is accepted, and the recovery engine talks
 * only to this interface — so swapping providers, or running with none at all, is a
 * configuration change rather than a code change.
 *
 * A nominal run makes zero calls through here. That is the design, and it is a
 * measured property: `llmCalls` is a run counter and appears in every report.
 */

export type LlmContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mediaType: string;
      /** Base64 payload, without a data: prefix. */
      readonly dataBase64: string;
    };

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string | readonly LlmContentPart[];
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Ask the endpoint for a JSON object, where it supports doing so. */
  readonly json?: boolean;
}

export interface LlmUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly usage?: LlmUsage;
}

export interface LlmProvider {
  /** Identifier for logs and reports, e.g. `openrouter/anthropic/claude-sonnet-4.6`. */
  readonly name: string;
  /** Whether image parts may be sent. Gates the L3 (screenshot) level. */
  readonly supportsImages: boolean;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
