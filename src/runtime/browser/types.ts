/**
 * The browser port.
 *
 * Nothing above this line knows Chrome exists. Workflows, the crawl loop and the
 * report writer talk to `BrowserBackend` and `PageHandle`; only the adapters in
 * `cdp.ts` and `fake.ts` know about CDP or a parsed DOM (decision D3).
 *
 * **Data, not handles.** `query()` returns an `ElementSnapshot` — a value — rather
 * than a live element handle, and actions take selectors. Handles would leak
 * backend specifics into every call site and carry staleness bugs across
 * navigations; a snapshot cannot go stale because it never claims to be live.
 */

import type { ElementView } from './interactable.js';
import type { ExtractedRecord, ExtractSpec, FieldMap } from '../extraction/spec.js';

export type { ExtractedRecord, ExtractSpec, FieldMap };

/** How long to wait before a navigation or a wait is considered failed. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type LoadState = 'domcontentloaded' | 'load' | 'networkidle';

export interface OpenOptions {
  readonly waitUntil?: LoadState;
  readonly timeoutMs?: number;
  /** Viewport in CSS pixels, from the browser profile. */
  readonly viewport?: readonly [number, number];
}

export interface NavigationResult {
  /** Final URL, after every redirect. */
  readonly url: string;
  /**
   * HTTP status of the final response, or `null` when there is none to speak of
   * (a `data:` or `about:` URL). Absent from the project we audited, and required
   * by the `audit` workflow's `http_status` and `unexpected_redirect` checks.
   */
  readonly status: number | null;
  /** URLs traversed before the final one, oldest first. Empty when direct. */
  readonly redirectChain: readonly string[];
  /** True for a 2xx/3xx final status, or for a status-less navigation that loaded. */
  readonly ok: boolean;
}

export interface ReadyOptions {
  /** Load milestone to wait for. Defaults to `load`. */
  readonly state?: LoadState;
  /** Additionally wait for this selector to be present. */
  readonly selector?: string;
  readonly timeoutMs?: number;
}

export interface ElementSnapshot {
  readonly selector: string;
  readonly tagName: string;
  /** Whitespace-normalised text content. */
  readonly text: string;
  readonly html: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Input to `isHumanInteractable`. */
  readonly view: ElementView;
}

export interface ScreenshotOptions {
  readonly fullPage?: boolean;
  /** Capture just this element instead of the page. */
  readonly selector?: string;
  readonly type?: 'png' | 'jpeg';
}

export interface FetchResult {
  /** Final URL after redirects. */
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  /** Media type from `content-type`, without parameters. `null` when absent. */
  readonly mediaType: string | null;
}

export interface ClickOptions {
  readonly timeoutMs?: number;
  /**
   * Click even when `isHumanInteractable` rejects the element. Off by default: a
   * workflow that needs this is usually pointing at the wrong element.
   */
  readonly force?: boolean;
}

/**
 * A page under our control.
 *
 * Every method is failure-explicit: a timeout throws rather than resolving with a
 * result indistinguishable from success. The project we audited had navigation
 * silently resolve on timeout, which made every downstream check unreliable.
 */
export interface PageHandle {
  /** Current URL. */
  url(): string;
  /** Status of the last navigation, or `null`. */
  status(): number | null;
  /** Redirect chain of the last navigation. */
  redirectChain(): readonly string[];

  navigate(url: string, options?: OpenOptions): Promise<NavigationResult>;
  /** Waits for a load milestone and, optionally, a selector. Throws on timeout. */
  waitForReady(options?: ReadyOptions): Promise<void>;

  /** First match, or `null`. Never throws for a missing element. */
  query(selector: string): Promise<ElementSnapshot | null>;
  queryAll(selector: string): Promise<ElementSnapshot[]>;

  /** Structured extraction. Returns one record per matched item, typed by the spec. */
  extractAll<F extends FieldMap>(spec: ExtractSpec<F>): Promise<ExtractedRecord<F>[]>;

  /** Clicks an element, refusing non-interactable ones unless forced. */
  click(selector: string, options?: ClickOptions): Promise<void>;

  /** Full HTML of the document. */
  content(): Promise<string>;
  /** Whitespace-normalised visible text of the document. */
  text(): Promise<string>;

  screenshot(options?: ScreenshotOptions): Promise<Buffer>;

  /**
   * Fetches a URL using the page's session — same cookies, same auth.
   *
   * This is how documents are collected. It is deliberately not a click-driven
   * download: fetching returns bytes, a status and headers synchronously with the
   * call, where a download event is a race against the browser's own file handling.
   */
  fetch(url: string, options?: { readonly timeoutMs?: number }): Promise<FetchResult>;

  close(): Promise<void>;
}

export interface BrowserBackend {
  /** Opens a page and navigates to `url`. */
  open(url: string, options?: OpenOptions): Promise<PageHandle>;
  /** Opens a page without navigating. */
  newPage(options?: OpenOptions): Promise<PageHandle>;
  /** Releases the backend's resources. Does not stop a shared, persistent Chrome. */
  close(): Promise<void>;
}

/** Thrown when a navigation or wait exceeds its budget. Never swallowed. */
export class NavigationTimeoutError extends Error {
  constructor(
    readonly target: string,
    readonly timeoutMs: number,
    cause?: unknown,
  ) {
    super(`Timed out after ${String(timeoutMs)}ms waiting for ${target}`);
    this.name = 'NavigationTimeoutError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Thrown when a click targets an element a person could not interact with. */
export class NotInteractableError extends Error {
  constructor(
    readonly selector: string,
    readonly reasons: readonly string[],
  ) {
    super(`Element "${selector}" is not human-interactable: ${reasons.join(', ')}`);
    this.name = 'NotInteractableError';
  }
}

/** Thrown when a selector matches nothing and the caller required a match. */
export class ElementNotFoundError extends Error {
  constructor(readonly selector: string) {
    super(`No element matched "${selector}"`);
    this.name = 'ElementNotFoundError';
  }
}
