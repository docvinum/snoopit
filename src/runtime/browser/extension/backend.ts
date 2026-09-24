/**
 * A backend driven through snoopit's browser extension instead of CDP.
 *
 * The Chrome is one a person can see, with no remote-debugging port: the extension
 * inside it connects to a loopback WebSocket that snoopit opens for the run, proves
 * it holds the pairing token, and then executes page operations one at a time. The
 * page-side code is `page-functions.ts` — the very functions the CDP backend
 * evaluates — so both backends measure, extract and decide identically.
 *
 * What the extension cannot do as CDP does, and how it is handled:
 *
 *  - **Clicks are DOM clicks** (`element.click()`), not synthesised mouse input.
 *    The interactability check runs first, as for CDP.
 *  - **Screenshots are of the visible viewport**; `fullPage` is not honoured.
 *  - **The HTTP cache** is bypassed by revalidating main-frame requests
 *    (`Cache-Control: max-age=0`, what a reload sends) rather than disabled.
 */

import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  normalizeText,
  parseExtractSpec,
  type ExtractedRecord,
  type ExtractSpec,
  type FieldMap,
} from '../../extraction/spec.js';
import { isHumanInteractable } from '../interactable.js';
import type { RawSnapshot } from '../page-functions.js';
import {
  DEFAULT_TIMEOUT_MS,
  ElementNotFoundError,
  NavigationTimeoutError,
  NotInteractableError,
  type BrowserBackend,
  type ClickOptions,
  type ElementSnapshot,
  type FetchResult,
  type LoadState,
  type NavigationResult,
  type OpenOptions,
  type PageHandle,
  type ReadyOptions,
  type ScreenshotOptions,
  type ScrollDirection,
} from '../types.js';
import { MIN_TOKEN_LENGTH, newNonce, proof, verifyProof } from './handshake.js';
import {
  DEFAULT_EXTENSION_PORT,
  PROTOCOL,
  type CallResult,
  type ExtensionMessage,
  type FetchWireResult,
  type NavigateResult,
  type Operation,
  type PageFunctionName,
  type ServerMessage,
  type WireError,
} from './protocol.js';

export interface ExtensionBackendOptions {
  /** Pairing secret, shared with the extension's options page. Never logged. */
  readonly token: string;
  /** Loopback port the extension connects to. */
  readonly port?: number;
  /**
   * How long to wait for the extension to connect. It retries at least every 30 s
   * (the shortest alarm Chrome allows), so this must exceed that.
   */
  readonly connectTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
}

/** No extension came: Chrome closed, extension missing, or a different token. */
export class ExtensionUnavailableError extends Error {
  constructor(port: number, waitedMs: number, detail: string | null) {
    super(
      `No snoopit extension connected on 127.0.0.1:${String(port)} within ` +
        `${String(Math.round(waitedMs / 1000))}s` +
        (detail === null ? '' : ` (${detail})`) +
        ' — is the dedicated Chrome running, with the extension installed and paired?',
    );
    this.name = 'ExtensionUnavailableError';
  }
}

/** The extension went away mid-run. */
export class ExtensionDisconnectedError extends Error {
  constructor() {
    super('The snoopit extension disconnected during the run');
    this.name = 'ExtensionDisconnectedError';
  }
}

/** A WebSocket frame as text. The protocol only ever sends JSON text frames. */
function asText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Keeps the extension's service worker awake: Chrome idles it after 30 s. */
const KEEPALIVE_MS = 20_000;
/** Extra time granted to a request beyond its own timeout, for the round trip. */
const TRANSPORT_MARGIN_MS = 10_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** One authenticated connection, turned into request/response calls. */
class Bridge {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly closedTabs = new Set<number>();
  private readonly keepalive: NodeJS.Timeout;
  private open = true;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.onMessage(asText(data));
    });
    socket.on('close', () => {
      this.open = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new ExtensionDisconnectedError());
      }
      this.pending.clear();
    });
    this.keepalive = setInterval(() => {
      this.request({ op: 'ping' }, 5_000).catch(() => undefined);
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  isTabClosed(tabId: number): boolean {
    return this.closedTabs.has(tabId);
  }

  request<T>(operation: Operation, timeoutMs: number): Promise<T> {
    if (!this.open) return Promise.reject(new ExtensionDisconnectedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension did not answer ${operation.op} within ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const message: ServerMessage = { type: 'request', id, operation };
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    clearInterval(this.keepalive);
    this.socket.close();
  }

  private onMessage(raw: string): void {
    let message: ExtensionMessage;
    try {
      message = JSON.parse(raw) as ExtensionMessage;
    } catch {
      return;
    }
    if (message.type === 'event') {
      if (message.event === 'tabClosed') this.closedTabs.add(message.tabId);
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(wireError(message.error));
  }
}

/** Rebuilds the port's own error classes, so callers cannot tell backends apart. */
function wireError(error: WireError): Error {
  if (error.name === 'NavigationTimeoutError') {
    const match = /after (\d+)ms waiting for (.*)$/.exec(error.message);
    return new NavigationTimeoutError(match?.[2] ?? error.message, Number(match?.[1] ?? 0));
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

/**
 * Opens the loopback server and waits for the extension to connect and prove it
 * holds the token. Anything else that connects is dropped after the handshake fails.
 */
async function acceptExtension(
  token: string,
  port: number,
  timeoutMs: number,
): Promise<{ server: WebSocketServer; bridge: Bridge }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  let lastFailure: string | null = null;
  return new Promise((resolve, reject) => {
    let done = false;
    const deadline = setTimeout(() => {
      done = true;
      server.close();
      reject(new ExtensionUnavailableError(port, timeoutMs, lastFailure));
    }, timeoutMs);

    server.on('connection', (socket) => {
      if (done) {
        socket.close(1013, 'busy');
        return;
      }
      const nonce = newNonce();
      const hello: ServerMessage = { type: 'hello', protocol: PROTOCOL, nonce };
      socket.send(JSON.stringify(hello));

      const giveUp = setTimeout(
        () => socket.close(1008, 'handshake timeout'),
        HANDSHAKE_TIMEOUT_MS,
      );
      socket.once('message', (data) => {
        clearTimeout(giveUp);
        let message: ExtensionMessage | null = null;
        try {
          message = JSON.parse(asText(data)) as ExtensionMessage;
        } catch {
          message = null;
        }
        if (message?.type !== 'hello' || message.protocol !== PROTOCOL) {
          lastFailure = 'an incompatible client connected';
          socket.close(1002, 'protocol');
          return;
        }
        if (!verifyProof(token, 'extension', nonce, message.proof)) {
          lastFailure = 'an extension connected with a different pairing token';
          socket.close(1008, 'unauthorised');
          return;
        }
        if (done) {
          socket.close(1013, 'busy');
          return;
        }
        done = true;
        clearTimeout(deadline);
        const welcome: ServerMessage = {
          type: 'welcome',
          proof: proof(token, 'server', message.nonce),
        };
        socket.send(JSON.stringify(welcome));
        resolve({ server, bridge: new Bridge(socket) });
      });
    });
  });
}

class ExtensionPage implements PageHandle {
  private href = 'about:blank';
  private lastStatus: number | null = null;
  private lastRedirects: string[] = [];
  private closed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly tabId: number,
    private readonly defaultTimeoutMs: number,
    private readonly useHttpCache: boolean,
  ) {}

  url(): string {
    return this.href;
  }

  status(): number | null {
    return this.lastStatus;
  }

  redirectChain(): readonly string[] {
    return this.lastRedirects;
  }

  private async call<T>(
    fn: PageFunctionName,
    args: readonly unknown[],
    timeoutMs?: number,
  ): Promise<T> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const result = await this.bridge.request<CallResult>(
      { op: 'call', tabId: this.tabId, fn, args, timeoutMs: timeout },
      timeout + TRANSPORT_MARGIN_MS,
    );
    this.href = result.href;
    return result.value as T;
  }

  async navigate(url: string, options: OpenOptions = {}): Promise<NavigationResult> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const result = await this.bridge.request<NavigateResult>(
      {
        op: 'navigate',
        tabId: this.tabId,
        url,
        timeoutMs: timeout,
        useHttpCache: options.useHttpCache ?? this.useHttpCache,
      },
      timeout + TRANSPORT_MARGIN_MS,
    );
    this.href = result.url;
    this.lastStatus = result.status;
    this.lastRedirects = result.redirectChain;
    const status = result.status;
    return {
      url: result.url,
      status,
      redirectChain: result.redirectChain,
      ok: status === null ? true : status >= 200 && status < 400,
    };
  }

  async waitForReady(options: ReadyOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const state: LoadState = options.state ?? 'load';
    const reached = await this.call<boolean>(
      'waitForPage',
      [state, options.selector ?? null, timeout],
      timeout,
    );
    if (!reached) throw new NavigationTimeoutError(options.selector ?? state, timeout);
  }

  private toSnapshot(raw: RawSnapshot, selector: string): ElementSnapshot {
    return {
      selector,
      tagName: raw.tagName,
      text: normalizeText(raw.text),
      html: raw.html,
      attributes: raw.attributes,
      view: raw.view,
    };
  }

  async query(selector: string): Promise<ElementSnapshot | null> {
    const [raw] = await this.call<RawSnapshot[]>('snapshotElements', [selector, true]);
    return raw === undefined ? null : this.toSnapshot(raw, selector);
  }

  async queryAll(selector: string): Promise<ElementSnapshot[]> {
    const raws = await this.call<RawSnapshot[]>('snapshotElements', [selector, false]);
    return raws.map((raw) => this.toSnapshot(raw, selector));
  }

  async extractAll<F extends FieldMap>(spec: ExtractSpec<F>): Promise<ExtractedRecord<F>[]> {
    const fields = Array.from(parseExtractSpec(spec), ([name, field]) => ({
      name,
      selector: field.selector,
      attribute: field.attribute,
    }));
    const raw = await this.call<Record<string, string | null>[]>('extractRecords', [
      { itemSelector: spec.selector, fieldSpecs: fields },
    ]);
    const textFields = new Set(fields.filter((f) => f.attribute === 'text').map((f) => f.name));
    return raw.map((record) => {
      const normalized: Record<string, string | null> = {};
      for (const [name, value] of Object.entries(record)) {
        normalized[name] = value !== null && textFields.has(name) ? normalizeText(value) : value;
      }
      return normalized as ExtractedRecord<F>;
    });
  }

  async click(selector: string, options: ClickOptions = {}): Promise<void> {
    const snapshot = await this.query(selector);
    if (snapshot === null) throw new ElementNotFoundError(selector);
    if (options.force !== true) {
      const verdict = isHumanInteractable(snapshot.view);
      if (!verdict.interactable) throw new NotInteractableError(selector, verdict.reasons);
    }
    const clicked = await this.call<boolean>('clickElement', [selector], options.timeoutMs);
    if (!clicked) throw new ElementNotFoundError(selector);
  }

  async scroll(direction: ScrollDirection): Promise<void> {
    await this.call<null>('scrollPage', [direction]);
  }

  content(): Promise<string> {
    return this.call<string>('pageContent', []);
  }

  async text(): Promise<string> {
    return normalizeText(await this.call<string>('pageText', []));
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    let box: { x: number; y: number; width: number; height: number } | null = null;
    if (options.selector !== undefined) {
      box = await this.call<typeof box>('elementBox', [options.selector]);
      if (box === null) throw new ElementNotFoundError(options.selector);
    }
    const result = await this.bridge.request<{ dataBase64: string }>(
      { op: 'screenshot', tabId: this.tabId, format: options.type ?? 'png', box },
      this.defaultTimeoutMs + TRANSPORT_MARGIN_MS,
    );
    return Buffer.from(result.dataBase64, 'base64');
  }

  async fetch(url: string, options: { readonly timeoutMs?: number } = {}): Promise<FetchResult> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const result = await this.bridge.request<FetchWireResult>(
      { op: 'fetch', tabId: this.tabId, url, timeoutMs: timeout },
      timeout + TRANSPORT_MARGIN_MS,
    );
    const raw = result.headers['content-type'];
    return {
      url: result.url,
      status: result.status,
      headers: result.headers,
      body: Buffer.from(result.bodyBase64, 'base64'),
      mediaType: raw === undefined ? null : (raw.split(';')[0]?.trim() ?? null),
    };
  }

  async close(): Promise<void> {
    if (this.isClosed()) return;
    this.closed = true;
    await this.bridge.request({ op: 'close', tabId: this.tabId }, 10_000);
  }

  isClosed(): boolean {
    return this.closed || this.bridge.isTabClosed(this.tabId);
  }
}

export class ExtensionBackend implements BrowserBackend {
  private constructor(
    private readonly server: WebSocketServer,
    private readonly bridge: Bridge,
    private readonly defaultTimeoutMs: number,
  ) {}

  /**
   * Opens the loopback endpoint and waits for the extension. Throws
   * `ExtensionUnavailableError` when none connects in time.
   */
  static async connect(options: ExtensionBackendOptions): Promise<ExtensionBackend> {
    if (options.token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `The extension pairing token must be at least ${String(MIN_TOKEN_LENGTH)} characters`,
      );
    }
    const port = options.port ?? DEFAULT_EXTENSION_PORT;
    const { server, bridge } = await acceptExtension(
      options.token,
      port,
      options.connectTimeoutMs ?? 45_000,
    );
    return new ExtensionBackend(server, bridge, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async newPage(options: OpenOptions = {}): Promise<PageHandle> {
    const { tabId } = await this.bridge.request<{ tabId: number }>(
      { op: 'newPage', viewport: options.viewport ?? null },
      TRANSPORT_MARGIN_MS,
    );
    return new ExtensionPage(
      this.bridge,
      tabId,
      options.timeoutMs ?? this.defaultTimeoutMs,
      options.useHttpCache === true,
    );
  }

  async open(url: string, options: OpenOptions = {}): Promise<PageHandle> {
    const page = await this.newPage(options);
    await page.navigate(url, options);
    return page;
  }

  /** Closes the endpoint. Chrome and the extension keep running; they belong to the person. */
  close(): Promise<void> {
    this.bridge.close();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}
