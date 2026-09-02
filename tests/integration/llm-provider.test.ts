/**
 * The OpenAI-compatible adapter, against a local stub endpoint.
 *
 * No test reaches a real provider: the behaviour under test is our request shaping,
 * retry policy and error handling, none of which needs a paid round trip.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OpenAiCompatibleProvider,
  openRouterHeaders,
} from '../../src/runtime/recovery/llm/openai-compatible.js';
import { LlmError } from '../../src/runtime/recovery/llm/provider.js';

interface Stub {
  readonly baseUrl: string;
  readonly requests: { headers: Record<string, string | string[] | undefined>; body: unknown }[];
  close(): Promise<void>;
}

/** A stub endpoint whose replies are scripted per request. */
async function startStub(replies: readonly { status: number; body: unknown }[]): Promise<Stub> {
  const requests: Stub['requests'] = [];
  let index = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply?.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub did not bind');

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ok = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
});

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

describe('OpenAiCompatibleProvider', () => {
  it('returns the reply and its usage', async () => {
    stub = await startStub([ok('{"action":"give_up"}')]);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: stub.baseUrl,
      model: 'test-model',
      apiKey: 'sk-test',
    });

    const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('{"action":"give_up"}');
    expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 4 });
  });

  it('sends the key as a bearer token and never in the model name', async () => {
    stub = await startStub([ok('ok')]);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: stub.baseUrl,
      model: 'test-model',
      apiKey: 'sk-secret',
    });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(stub.requests[0]!.headers['authorization']).toBe('Bearer sk-secret');
    expect(provider.name).not.toContain('sk-secret');
  });

  it('omits the header entirely for a keyless endpoint', async () => {
    stub = await startStub([ok('ok')]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'local' });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(stub.requests[0]!.headers['authorization']).toBeUndefined();
  });

  it('encodes an image part as a data URL', async () => {
    stub = await startStub([ok('ok')]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'm' });

    await provider.complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
          ],
        },
      ],
    });

    const body = stub.requests[0]!.body as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    const parts = body.messages[0]!.content;
    expect(parts[0]).toEqual({ type: 'text', text: 'look' });
    expect(parts[1]?.image_url?.url).toBe('data:image/png;base64,AAAA');
  });

  it('asks for a JSON object when requested', async () => {
    stub = await startStub([ok('{}')]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'm' });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], json: true });

    expect(stub.requests[0]!.body).toMatchObject({
      response_format: { type: 'json_object' },
      temperature: 0,
    });
  });

  it('retries once on a rate limit, then succeeds', async () => {
    stub = await startStub([{ status: 429, body: { error: 'slow down' } }, ok('recovered')]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'm' });

    const response = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('recovered');
    expect(stub.requests).toHaveLength(2);
  });

  it('does not retry a request the endpoint rejected outright', async () => {
    // A 400 will fail identically however many times it is sent.
    stub = await startStub([{ status: 400, body: { error: 'bad request' } }]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'm' });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(LlmError);
    expect(stub.requests).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    stub = await startStub([{ status: 500, body: {} }]);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: stub.baseUrl,
      model: 'm',
      maxRetries: 1,
    });

    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/500/);
    expect(stub.requests).toHaveLength(2);
  });

  it('fails clearly when the reply has no content', async () => {
    stub = await startStub([{ status: 200, body: { choices: [] } }]);
    const provider = new OpenAiCompatibleProvider({ baseUrl: stub.baseUrl, model: 'm' });
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/no message content/);
  });

  it('sends OpenRouter attribution headers when configured', async () => {
    stub = await startStub([ok('ok')]);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: stub.baseUrl,
      model: 'm',
      headers: openRouterHeaders(),
    });
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(stub.requests[0]!.headers['x-title']).toBe('snoopit');
  });
});
