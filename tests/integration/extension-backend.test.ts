/**
 * The extension backend's own contract: pairing, refusal, disconnection, and the
 * behaviours only a real browser shows.
 *
 * The first half needs no browser: a WebSocket client plays the extension, so the
 * Node side of the protocol — the half that decides who may drive the browser — is
 * tested on every machine. The second half runs the real extension in Chromium and
 * is skipped where there is none.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  ExtensionBackend,
  ExtensionDisconnectedError,
  ExtensionUnavailableError,
} from '../../src/runtime/browser/extension/backend.js';
import {
  PROTOCOL,
  proofMessage,
  type ExtensionMessage,
  type ServerMessage,
} from '../../src/runtime/browser/extension/protocol.js';
import { NavigationTimeoutError } from '../../src/runtime/browser/types.js';
import {
  extensionBrowserAvailable,
  launchExtensionBrowser,
  type ExtensionBrowser,
} from '../support/extension-browser.js';
import { startFixtureServer, type FixtureServer } from '../support/server.js';

const TOKEN = 'a-pairing-token-that-is-long-enough-000000';
let nextPort = 19400;
const port = (): number => nextPort++;

const sign = (token: string, role: 'extension' | 'server', nonce: string): string =>
  createHmac('sha256', token).update(proofMessage(role, nonce)).digest('hex');

/** A stand-in for the extension, answering requests with `answer`. */
function fakeExtension(
  target: number,
  options: {
    token?: string;
    answer?: (operation: { op: string }, reply: (message: ExtensionMessage) => void) => void;
  } = {},
): Promise<{ socket: WebSocket; closed: Promise<number>; welcomed: Promise<boolean> }> {
  const token = options.token ?? TOKEN;
  const socket = new WebSocket(`ws://127.0.0.1:${String(target)}`);
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  let welcomed: (value: boolean) => void = () => undefined;
  const welcome = new Promise<boolean>((resolve) => (welcomed = resolve));
  const nonce = 'extension-nonce';
  const reply = (message: ExtensionMessage): void => socket.send(JSON.stringify(message));

  socket.on('message', (data) => {
    const message = JSON.parse((data as Buffer).toString('utf8')) as ServerMessage;
    if (message.type === 'hello') {
      reply({
        type: 'hello',
        protocol: PROTOCOL,
        nonce,
        proof: sign(token, 'extension', message.nonce),
        version: 'test',
      });
    } else if (message.type === 'welcome') {
      welcomed(message.proof === sign(token, 'server', nonce));
    } else if (message.type === 'request') {
      options.answer?.(message.operation, (response) =>
        reply({ ...response, id: message.id } as ExtensionMessage),
      );
    }
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, closed, welcomed: welcome }));
    socket.once('error', reject);
  });
}

/** Retries until the server is listening. */
async function fakeExtensionWhenReady(
  target: number,
  options: Parameters<typeof fakeExtension>[1] = {},
): ReturnType<typeof fakeExtension> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fakeExtension(target, options);
    } catch (error) {
      if (attempt > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const ok = (result: unknown): ExtensionMessage => ({ type: 'response', id: 0, ok: true, result });

describe('ExtensionBackend — pairing and protocol', () => {
  it('pairs with an extension that proves the token, and proves it back', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 5_000,
    });
    const extension = await fakeExtensionWhenReady(target);

    const backend = await connecting;
    // The extension can check that it is talking to snoopit and not to any process
    // that happened to open the port first.
    expect(await extension.welcomed).toBe(true);
    await backend.close();
  });

  it('refuses an extension with a different token, and says why', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 1_500,
    });
    const impostor = await fakeExtensionWhenReady(target, {
      token: 'another-token-that-is-also-long-000000',
    });

    expect(await impostor.closed).toBe(1008);
    await expect(connecting).rejects.toThrow(ExtensionUnavailableError);
    await expect(connecting).rejects.toThrow(/different pairing token/);
  });

  it('fails clearly when no extension connects', async () => {
    await expect(
      ExtensionBackend.connect({ token: TOKEN, port: port(), connectTimeoutMs: 300 }),
    ).rejects.toThrow(/No snoopit extension connected on 127\.0\.0\.1/);
  });

  it('refuses a token too short to protect a browser holding sessions', async () => {
    await expect(ExtensionBackend.connect({ token: 'short', port: port() })).rejects.toThrow(
      /at least 32 characters/,
    );
  });

  it('turns wire errors back into the port’s own error classes', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 5_000,
    });
    await fakeExtensionWhenReady(target, {
      answer: (operation, reply) => {
        if (operation.op === 'newPage') reply(ok({ tabId: 7 }));
        else if (operation.op === 'navigate') {
          reply({
            type: 'response',
            id: 0,
            ok: false,
            error: {
              name: 'NavigationTimeoutError',
              message: 'Timed out after 1200ms waiting for http://site.test/slow',
            },
          });
        }
      },
    });
    const backend = await connecting;

    const page = await backend.newPage();
    const error = await page.navigate('http://site.test/slow').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NavigationTimeoutError);
    expect((error as NavigationTimeoutError).timeoutMs).toBe(1200);
    await backend.close();
  });

  it('follows the page URL the extension reports after each call', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 5_000,
    });
    await fakeExtensionWhenReady(target, {
      answer: (operation, reply) => {
        if (operation.op === 'newPage') reply(ok({ tabId: 3 }));
        // A click that navigated, as on leboncoin: the next call reports the new URL.
        else reply(ok({ value: true, href: 'http://site.test/results?saved_id_view=abc' }));
      },
    });
    const backend = await connecting;
    const page = await backend.newPage();

    await page.waitForReady({ selector: 'nav' });
    expect(page.url()).toBe('http://site.test/results?saved_id_view=abc');
    await backend.close();
  });

  it('knows a tab closed by a person is closed', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 5_000,
    });
    const extension = await fakeExtensionWhenReady(target, {
      answer: (operation, reply) => {
        if (operation.op === 'newPage') reply(ok({ tabId: 5 }));
      },
    });
    const backend = await connecting;
    const page = await backend.newPage();
    expect(page.isClosed()).toBe(false);

    extension.socket.send(JSON.stringify({ type: 'event', event: 'tabClosed', tabId: 5 }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(page.isClosed()).toBe(true);
    await backend.close();
  });

  it('fails pending work explicitly when the extension goes away', async () => {
    const target = port();
    const connecting = ExtensionBackend.connect({
      token: TOKEN,
      port: target,
      connectTimeoutMs: 5_000,
    });
    const extension = await fakeExtensionWhenReady(target, {
      answer: (operation, reply) => {
        if (operation.op === 'newPage') reply(ok({ tabId: 9 }));
        // Any other request is left unanswered: the extension is about to vanish.
      },
    });
    const backend = await connecting;
    const page = await backend.newPage();

    const pending = page.text();
    extension.socket.terminate();
    await expect(pending).rejects.toThrow(ExtensionDisconnectedError);
    await backend.close();
  });
});

describe('ExtensionBackend — in a real Chromium', () => {
  let browser: ExtensionBrowser | null = null;
  let server: FixtureServer;
  let backend: ExtensionBackend;
  const target = 19480;

  beforeAll(async () => {
    server = await startFixtureServer();
    if (!extensionBrowserAvailable()) return;
    browser = await launchExtensionBrowser(target);
    backend = await browser.connect();
  }, 60_000);

  afterAll(async () => {
    if (browser !== null) {
      await backend.close();
      await browser.close();
    }
    await server.close();
  });

  it('throws NavigationTimeoutError instead of resolving on a hung request', async () => {
    if (browser === null) return;
    const page = await backend.newPage();
    await expect(page.navigate(server.url('/slow'), { timeoutMs: 1200 })).rejects.toThrow(
      NavigationTimeoutError,
    );
    await page.close();
  });

  it('follows a click that navigates, and reports where it landed', async () => {
    if (browser === null) return;
    const page = await backend.open(server.url('/index.html'));
    await page.click('#next-page');
    // Wait for something only the destination has: the page we left still matches
    // anything generic until the navigation replaces it.
    await page.waitForReady({ selector: 'link[rel="canonical"][href="/page-2.html"]' });
    expect(page.url()).toContain('/page-2.html');
    await page.close();
  });

  it('does nothing for a server that cannot prove it holds the token', async () => {
    if (browser === null) return;
    await backend.close();

    // Something else took the port: it speaks the protocol but does not know the token.
    const rogue = new WebSocketServer({ host: '127.0.0.1', port: target });
    const outcome = await new Promise<{ answered: boolean; closed: boolean }>((resolve) => {
      let answered = false;
      rogue.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, nonce: 'rogue' }));
        socket.once('message', () => {
          socket.send(JSON.stringify({ type: 'welcome', proof: 'forged' }));
          socket.send(
            JSON.stringify({
              type: 'request',
              id: 1,
              operation: { op: 'newPage', viewport: null },
            }),
          );
          socket.on('message', () => (answered = true));
          socket.on('close', () => resolve({ answered, closed: true }));
        });
      });
      setTimeout(() => resolve({ answered, closed: false }), 15_000);
    });
    await new Promise<void>((resolve) => rogue.close(() => resolve()));

    expect(outcome).toEqual({ answered: false, closed: true });
    backend = await browser.connect();
  }, 30_000);

  it('reconnects for the next job of a tick, as snoopit reopens its endpoint', async () => {
    if (browser === null) return;
    await backend.close();
    backend = await browser.connect();
    const page = await backend.open(server.url('/index.html'));
    expect(page.status()).toBe(200);
    await page.close();
  }, 30_000);
});
