/**
 * The production backend: a persistent Chrome, attached over CDP.
 *
 * Chrome is launched and supervised outside this process (systemd on the OptiPlex)
 * with a dedicated `--user-data-dir` and `--remote-debugging-port` bound to
 * loopback. We attach to it; we never launch a throwaway browser.
 *
 * That distinction is the whole reason `playwright-core` is usable here. The
 * project we audited rejected Playwright because `launch()` yields a sterile
 * profile with no cookies — true, and irrelevant: `connectOverCDP()` attaches to a
 * browser that is already running and already authenticated. We get the persistent
 * profile *and* a mature protocol client, instead of hand-rolling CDP calls.
 *
 * Nothing outside this file imports `playwright-core`.
 */

import type { Browser, BrowserContext, ElementHandle, Page, Response } from 'playwright-core';
import { chromium } from 'playwright-core';
import {
  normalizeText,
  parseExtractSpec,
  type ExtractedRecord,
  type ExtractSpec,
  type FieldMap,
} from '../extraction/spec.js';
import { isHumanInteractable, type ElementView } from './interactable.js';
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
} from './types.js';

export interface CdpBackendOptions {
  /** CDP endpoint of the persistent Chrome. Loopback only, by policy. */
  readonly cdpUrl: string;
  readonly defaultTimeoutMs?: number;
  readonly viewport?: readonly [number, number];
}

/**
 * Gathers an `ElementView` inside the page.
 *
 * Serialised as a function passed to `evaluate`, so it runs in the page's own
 * context where `getComputedStyle` and layout boxes exist. The *decision* stays in
 * `isHumanInteractable` on our side, shared with the fake backend — only the
 * measurement happens here.
 */
function measureElement(element: Element): ElementView {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  const closestMatching = (selector: string): boolean => element.closest(selector) !== null;

  // Reachable = intersects the viewport, or lives inside something scrollable that
  // could bring it into view. Content below the fold is ordinary interface.
  const inViewport =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  let scrollable = false;
  let node: Element | null = element.parentElement;
  while (node !== null && !scrollable) {
    const nodeStyle = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(nodeStyle.overflowY + nodeStyle.overflowX)) scrollable = true;
    node = node.parentElement;
  }
  const documentScrolls = document.documentElement.scrollHeight > window.innerHeight;

  return {
    width: rect.width,
    height: rect.height,
    display: style.display,
    visibility: style.visibility,
    opacity: Number(style.opacity),
    pointerEvents: style.pointerEvents,
    ariaHidden: closestMatching('[aria-hidden="true"]'),
    inert: closestMatching('[inert]'),
    hidden: closestMatching('[hidden]'),
    disabled: (element as HTMLInputElement).disabled === true,
    reachable: inViewport || scrollable || documentScrolls,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /Timeout .*exceeded|timeout/i.test(error.message);
}

function mediaTypeOf(headers: Record<string, string>): string | null {
  const raw = headers['content-type'];
  return raw === undefined ? null : (raw.split(';')[0]?.trim() ?? null);
}

class CdpPage implements PageHandle {
  private lastStatus: number | null = null;
  private lastRedirects: string[] = [];

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly defaultTimeoutMs: number,
  ) {}

  url(): string {
    return this.page.url();
  }

  status(): number | null {
    return this.lastStatus;
  }

  redirectChain(): readonly string[] {
    return this.lastRedirects;
  }

  /** Walks `redirectedFrom()` back to the first request, oldest first. */
  private static redirectChainOf(response: Response | null): string[] {
    const chain: string[] = [];
    let request = response?.request().redirectedFrom() ?? null;
    while (request !== null) {
      chain.unshift(request.url());
      request = request.redirectedFrom();
    }
    return chain;
  }

  async navigate(url: string, options: OpenOptions = {}): Promise<NavigationResult> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    let response: Response | null;
    try {
      response = await this.page.goto(url, {
        waitUntil: options.waitUntil ?? 'load',
        timeout,
      });
    } catch (error) {
      // A timeout must throw. The project we audited resolved on timeout, making a
      // failed navigation indistinguishable from a successful one downstream.
      if (isTimeout(error)) throw new NavigationTimeoutError(url, timeout, error);
      throw error;
    }

    this.lastStatus = response?.status() ?? null;
    this.lastRedirects = CdpPage.redirectChainOf(response);

    const status = this.lastStatus;
    return {
      url: this.page.url(),
      status,
      redirectChain: this.lastRedirects,
      ok: status === null ? true : status >= 200 && status < 400,
    };
  }

  async waitForReady(options: ReadyOptions = {}): Promise<void> {
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const state: LoadState = options.state ?? 'load';

    try {
      // Event-driven, never a `readyState` poll: the milestone is reported by the
      // browser rather than sampled every 300ms and hoped for.
      await this.page.waitForLoadState(state, { timeout });
      if (options.selector !== undefined) {
        await this.page.waitForSelector(options.selector, { timeout, state: 'attached' });
      }
    } catch (error) {
      if (isTimeout(error)) {
        throw new NavigationTimeoutError(options.selector ?? state, timeout, error);
      }
      throw error;
    }
  }

  private async snapshot(
    handle: ElementHandle<Element>,
    selector: string,
  ): Promise<ElementSnapshot> {
    const [tagName, text, html, attributes, view] = await Promise.all([
      handle.evaluate((el) => el.tagName.toLowerCase()),
      handle.evaluate((el) => el.textContent ?? ''),
      handle.evaluate((el) => el.innerHTML),
      handle.evaluate((el) => {
        const result: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) result[attr.name] = attr.value;
        return result;
      }),
      handle.evaluate(measureElement),
    ]);

    return { selector, tagName, text: normalizeText(text), html, attributes, view };
  }

  async query(selector: string): Promise<ElementSnapshot | null> {
    const handle = await this.page.$(selector);
    if (handle === null) return null;
    try {
      return await this.snapshot(handle, selector);
    } finally {
      await handle.dispose();
    }
  }

  async queryAll(selector: string): Promise<ElementSnapshot[]> {
    const handles = await this.page.$$(selector);
    try {
      return await Promise.all(handles.map((handle) => this.snapshot(handle, selector)));
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose()));
    }
  }

  async extractAll<F extends FieldMap>(spec: ExtractSpec<F>): Promise<ExtractedRecord<F>[]> {
    // Parsed on our side so both backends agree on what a spec means; only the
    // resolved (selector, attribute) pairs cross into the page.
    const fields = Array.from(parseExtractSpec(spec), ([name, field]) => ({
      name,
      selector: field.selector,
      attribute: field.attribute,
    }));

    const raw = await this.page.evaluate(
      ({ itemSelector, fieldSpecs }) =>
        Array.from(document.querySelectorAll(itemSelector)).map((item) => {
          const record: Record<string, string | null> = {};
          for (const field of fieldSpecs) {
            const target = field.selector === null ? item : item.querySelector(field.selector);
            if (target === null) {
              record[field.name] = null;
              continue;
            }
            if (field.attribute === 'text') {
              record[field.name] = target.textContent ?? '';
            } else if (field.attribute === 'html') {
              record[field.name] = target.innerHTML;
            } else if (field.attribute === 'href' || field.attribute === 'src') {
              // Resolved by the browser itself, which is authoritative about the
              // document's base URL (including any <base> tag).
              const property = field.attribute === 'href' ? 'href' : 'src';
              const resolved = (target as unknown as Record<string, unknown>)[property];
              record[field.name] =
                typeof resolved === 'string' && resolved !== ''
                  ? resolved
                  : target.getAttribute(field.attribute);
            } else {
              record[field.name] = target.getAttribute(field.attribute);
            }
          }
          return record;
        }),
      { itemSelector: spec.selector, fieldSpecs: fields },
    );

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
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const handle = await this.page.$(selector);
    if (handle === null) throw new ElementNotFoundError(selector);

    try {
      if (options.force !== true) {
        const verdict = isHumanInteractable(await handle.evaluate(measureElement));
        if (!verdict.interactable) {
          throw new NotInteractableError(selector, verdict.reasons);
        }
      }
      await handle.click({ timeout, force: options.force === true });
    } finally {
      await handle.dispose();
    }
  }

  async scroll(direction: ScrollDirection): Promise<void> {
    await this.page.evaluate((where: string) => {
      const step = window.innerHeight * 0.9;
      if (where === 'top') window.scrollTo({ top: 0 });
      else if (where === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
      else window.scrollBy({ top: where === 'down' ? step : -step });
    }, direction);
  }

  content(): Promise<string> {
    return this.page.content();
  }

  async text(): Promise<string> {
    return normalizeText(await this.page.evaluate(() => document.body.innerText));
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const type = options.type ?? 'png';
    if (options.selector !== undefined) {
      const handle = await this.page.$(options.selector);
      if (handle === null) throw new ElementNotFoundError(options.selector);
      try {
        return await handle.screenshot({ type });
      } finally {
        await handle.dispose();
      }
    }
    return this.page.screenshot({ fullPage: options.fullPage === true, type });
  }

  async fetch(url: string, options: { readonly timeoutMs?: number } = {}): Promise<FetchResult> {
    // Uses the context's request API, so cookies and auth match the page exactly.
    const response = await this.context.request.get(url, {
      timeout: options.timeoutMs ?? this.defaultTimeoutMs,
    });
    const headers = response.headers();
    return {
      url: response.url(),
      status: response.status(),
      headers,
      body: await response.body(),
      mediaType: mediaTypeOf(headers),
    };
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

export class CdpBackend implements BrowserBackend {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly defaultTimeoutMs: number,
    private readonly viewport: readonly [number, number] | undefined,
  ) {}

  /** Attaches to an already-running Chrome. Never launches one. */
  static async connect(options: CdpBackendOptions): Promise<CdpBackend> {
    const browser = await chromium.connectOverCDP(options.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return new CdpBackend(
      browser,
      context,
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.viewport,
    );
  }

  async newPage(options: OpenOptions = {}): Promise<PageHandle> {
    const page = await this.context.newPage();
    const viewport = options.viewport ?? this.viewport;
    if (viewport !== undefined) {
      await page.setViewportSize({ width: viewport[0], height: viewport[1] });
    }

    if (options.useHttpCache !== true) {
      // Change detection is only meaningful against what the site serves now. With
      // the cache on, a revisit can be answered from Chrome's own copy and the page
      // looks unchanged when it is not.
      const session = await this.context.newCDPSession(page);
      // `Network.enable` first: without the domain enabled the setting is accepted
      // and silently ignored, which looks like it worked and is not.
      await session.send('Network.enable');
      await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    }
    return new CdpPage(page, this.context, options.timeoutMs ?? this.defaultTimeoutMs);
  }

  async open(url: string, options: OpenOptions = {}): Promise<PageHandle> {
    const page = await this.newPage(options);
    await page.navigate(url, options);
    return page;
  }

  /**
   * Detaches from Chrome. The browser itself keeps running — it is a long-lived
   * service owned by systemd, not by this process.
   */
  async close(): Promise<void> {
    await this.browser.close();
  }
}
