/**
 * A provider that answers from a script.
 *
 * Every test of the recovery engine uses this: escalation, budgets, malformed
 * replies and refusals are all properties of *our* code, and testing them against a
 * real endpoint would make the suite slow, costly and non-deterministic for no gain.
 */

import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './provider.js';

export interface ScriptedReply {
  /** Text returned for this call, or an error to throw instead. */
  readonly text?: string;
  readonly error?: Error;
}

export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  /** Every request this provider received, for assertions about what was sent. */
  readonly requests: LlmRequest[] = [];

  private index = 0;

  constructor(
    private readonly replies: readonly ScriptedReply[],
    readonly supportsImages = true,
  ) {}

  get callCount(): number {
    return this.requests.length;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const reply = this.replies[this.index];
    this.index += 1;

    if (reply === undefined) {
      return Promise.reject(new LlmError('ScriptedLlmProvider: no reply left in the script'));
    }
    if (reply.error !== undefined) return Promise.reject(reply.error);
    return Promise.resolve({ text: reply.text ?? '' });
  }
}
