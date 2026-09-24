/**
 * The Node half of the pairing proof. The extension computes the same HMAC with
 * WebCrypto; `tests/unit/extension-handshake.test.ts` pins that both agree.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { proofMessage } from './protocol.js';

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function proof(token: string, role: 'extension' | 'server', nonce: string): string {
  return createHmac('sha256', token).update(proofMessage(role, nonce)).digest('hex');
}

/** Constant-time comparison: a proof must not be guessable byte by byte. */
export function verifyProof(
  token: string,
  role: 'extension' | 'server',
  nonce: string,
  candidate: unknown,
): boolean {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(proof(token, role, nonce), 'utf8');
  const given = Buffer.from(candidate, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Tokens shorter than this are refused outright. The token is the only thing
 * standing between any local process and a browser holding authenticated sessions.
 */
export const MIN_TOKEN_LENGTH = 32;
