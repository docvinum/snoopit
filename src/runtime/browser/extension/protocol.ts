/**
 * The wire protocol between snoopit and its browser extension.
 *
 * snoopit listens on a loopback WebSocket for the duration of a run; the extension,
 * living in a Chrome a person can see, connects to it and executes what it is asked.
 * Messages are JSON; bytes (screenshots, downloads) travel as base64.
 *
 * This file is shared: the extension build copies it next to its own code, so it
 * must hold only types and plain constants — **no runtime import**.
 *
 * Authentication is mutual and never sends the secret. Each side sends a nonce and
 * proves it knows the pairing token by returning `HMAC(token, proofMessage(role,
 * nonce))`. A local process that is not snoopit cannot drive the browser, and one
 * that is not the extension cannot pose as it — the lesson of the unauthenticated
 * CDP proxy the audit found (docs/BROWSER_AGENT_AUDIT.md).
 */

export const PROTOCOL = 'snoopit-extension/1';
export const DEFAULT_EXTENSION_PORT = 9333;

/** What gets signed. The role keeps a proof from being replayed in the other direction. */
export function proofMessage(role: 'extension' | 'server', nonce: string): string {
  return `${PROTOCOL}:${role}:${nonce}`;
}

/** Page-side functions the extension may call, from `page-functions.ts`. */
export type PageFunctionName =
  | 'snapshotElements'
  | 'extractRecords'
  | 'waitForPage'
  | 'clickElement'
  | 'scrollPage'
  | 'pageText'
  | 'pageContent'
  | 'elementBox'
  | 'fetchInPage';

export type Operation =
  | { readonly op: 'ping' }
  | { readonly op: 'newPage'; readonly viewport: readonly [number, number] | null }
  | {
      readonly op: 'navigate';
      readonly tabId: number;
      readonly url: string;
      readonly timeoutMs: number;
      readonly useHttpCache: boolean;
    }
  | {
      readonly op: 'call';
      readonly tabId: number;
      readonly fn: PageFunctionName;
      readonly args: readonly unknown[];
      readonly timeoutMs: number;
    }
  | {
      readonly op: 'screenshot';
      readonly tabId: number;
      readonly format: 'png' | 'jpeg';
      /** Crop, in device pixels. `null` captures the visible viewport. */
      readonly box: { x: number; y: number; width: number; height: number } | null;
    }
  | {
      readonly op: 'fetch';
      readonly tabId: number;
      readonly url: string;
      readonly timeoutMs: number;
    }
  | { readonly op: 'close'; readonly tabId: number };

export interface NavigateResult {
  readonly url: string;
  readonly status: number | null;
  readonly redirectChain: string[];
}

export interface CallResult {
  readonly value: unknown;
  /** The page's URL when the call returned: how snoopit follows clicks that navigate. */
  readonly href: string;
}

export interface FetchWireResult {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
}

/** Error names the extension may report. Mapped back to the port's error classes. */
export type WireErrorName =
  'NavigationTimeoutError' | 'NavigationError' | 'TabClosedError' | 'CallTimeoutError' | 'Error';

export interface WireError {
  readonly name: WireErrorName;
  readonly message: string;
}

export type ServerMessage =
  | { readonly type: 'hello'; readonly protocol: string; readonly nonce: string }
  | { readonly type: 'welcome'; readonly proof: string }
  | { readonly type: 'request'; readonly id: number; readonly operation: Operation };

export type ExtensionMessage =
  | {
      readonly type: 'hello';
      readonly protocol: string;
      readonly nonce: string;
      readonly proof: string;
      readonly version: string;
    }
  | { readonly type: 'response'; readonly id: number; readonly ok: true; readonly result: unknown }
  | {
      readonly type: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: WireError;
    }
  | { readonly type: 'event'; readonly event: 'tabClosed'; readonly tabId: number };
