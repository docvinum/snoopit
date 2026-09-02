/**
 * An adapter for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * OpenRouter is the first backend, but nothing here is specific to it beyond an
 * optional attribution header — the same adapter serves OpenAI, a local Ollama, or
 * anything else speaking the same shape.
 *
 * The API key is read from the environment by the caller and passed in. It is never
 * read from a config file, never logged, and never included in an error message.
 */

import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly model: string;
  /** Passed as a bearer token. Omit for endpoints that need none, such as Ollama. */
  readonly apiKey?: string | null;
  readonly timeoutMs?: number;
  /** Whether the model accepts images. Gates L3. */
  readonly supportsImages?: boolean;
  /** Extra headers, e.g. OpenRouter's attribution headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Retries on a transient failure (429 / 5xx / network). Default 1. */
  readonly maxRetries?: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Status codes worth one more attempt. Everything else is reported as-is. */
function isTransient(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function toOpenAiContent(content: LlmRequest['messages'][number]['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
  );
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly supportsImages: boolean;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = `${new URL(options.baseUrl).host}/${options.model}`;
    this.supportsImages = options.supportsImages ?? true;
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const maxRetries = this.options.maxRetries ?? 1;
    let lastError: LlmError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Bounded backoff. The audited project had no retry at all; unbounded retry
        // would be worse, since a rate limit is a request to slow down.
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
      try {
        return await this.attempt(request, signal);
      } catch (error) {
        lastError = error instanceof LlmError ? error : new LlmError(String(error));
        const retryable = lastError.status === undefined || isTransient(lastError.status);
        if (!retryable) throw lastError;
      }
    }
    throw lastError ?? new LlmError('LLM request failed');
  }

  private async attempt(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.options.headers,
    };
    if (this.options.apiKey !== undefined && this.options.apiKey !== null) {
      headers['authorization'] = `Bearer ${this.options.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: toOpenAiContent(message.content),
      })),
      temperature: request.temperature ?? 0,
    };
    if (request.maxTokens !== undefined) body['max_tokens'] = request.maxTokens;
    if (request.json === true) body['response_format'] = { type: 'json_object' };

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
      // The body may echo request details; keep it short and never include headers,
      // which carry the key.
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new LlmError(
        `LLM endpoint returned ${String(response.status)}: ${detail}`,
        response.status,
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new LlmError('LLM response contained no message content');
    }

    const usage = payload.usage;
    return {
      text,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              ...(usage.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
              ...(usage.completion_tokens === undefined
                ? {}
                : { completionTokens: usage.completion_tokens }),
            },
          }),
    };
  }
}

/** Builds the OpenRouter attribution headers, which the service asks integrators to send. */
export function openRouterHeaders(
  referer = 'https://github.com/docvinum/snoopit',
): Record<string, string> {
  return { 'http-referer': referer, 'x-title': 'snoopit' };
}
