/**
 * The two halves of the pairing proof must agree: Node signs with `node:crypto`,
 * the extension with WebCrypto. Both are exercised here on the same inputs.
 */

import { describe, expect, it } from 'vitest';
import { proof, verifyProof } from '../../src/runtime/browser/extension/handshake.js';
import { proofMessage } from '../../src/runtime/browser/extension/protocol.js';

async function webCryptoProof(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Buffer.from(signature).toString('hex');
}

const TOKEN = 'a-pairing-token-that-is-long-enough-000000';

describe('pairing proof', () => {
  it('is computed identically by Node and by the extension’s WebCrypto', async () => {
    for (const role of ['extension', 'server'] as const) {
      expect(proof(TOKEN, role, 'nonce-1')).toBe(
        await webCryptoProof(TOKEN, proofMessage(role, 'nonce-1')),
      );
    }
  });

  it('binds the role, so a proof cannot be replayed in the other direction', () => {
    expect(proof(TOKEN, 'extension', 'n')).not.toBe(proof(TOKEN, 'server', 'n'));
    expect(verifyProof(TOKEN, 'server', 'n', proof(TOKEN, 'extension', 'n'))).toBe(false);
  });

  it('accepts the right proof and refuses anything else', () => {
    expect(verifyProof(TOKEN, 'extension', 'n', proof(TOKEN, 'extension', 'n'))).toBe(true);
    expect(verifyProof(TOKEN, 'extension', 'n', proof('other-token', 'extension', 'n'))).toBe(
      false,
    );
    expect(verifyProof(TOKEN, 'extension', 'n', undefined)).toBe(false);
    expect(verifyProof(TOKEN, 'extension', 'n', 'short')).toBe(false);
  });
});
