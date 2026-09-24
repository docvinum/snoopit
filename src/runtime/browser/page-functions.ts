/**
 * Code that runs *inside* the page, shared by every real-browser backend.
 *
 * The CDP backend hands these functions to `page.evaluate`; the extension backend
 * injects the whole module into the page's isolated world and calls them by name.
 * Either way the measurement is the same code, so both backends reach the same
 * diagnosis through the same predicate — the property the conformance suite checks.
 *
 * Two constraints follow from how the code travels:
 *
 *  - **No runtime import.** The extension injects this file as a plain script; an
 *    `import` would break it. Type imports are erased and fine.
 *  - **`measureElement` and `extractRecords` are self-contained.** `page.evaluate`
 *    serialises a single function, so those two reference nothing outside their own
 *    body. The others run only from the injected module and may call each other.
 *
 * Values are returned raw — text is not whitespace-normalised here. Normalisation
 * happens on the Node side, once, with the same function for every backend.
 */

import type { ElementView } from './interactable.js';

/** Gathers the facts `isHumanInteractable` needs about one element. Self-contained. */
export function measureElement(element: Element): ElementView {
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

/** One field of an extraction, already resolved to a selector and an attribute. */
export interface FieldSpec {
  readonly name: string;
  /** `null` means the item itself. */
  readonly selector: string | null;
  readonly attribute: string;
}

/**
 * Extracts one record per item matching `itemSelector`. Self-contained.
 *
 * `href` and `src` are read as properties, so the browser — which knows the
 * document's base URL, `<base>` included — resolves them to absolute URLs.
 */
export function extractRecords(input: {
  readonly itemSelector: string;
  readonly fieldSpecs: readonly FieldSpec[];
}): Record<string, string | null>[] {
  return Array.from(document.querySelectorAll(input.itemSelector)).map((item) => {
    const record: Record<string, string | null> = {};
    for (const field of input.fieldSpecs) {
      // "The item itself" arrives as `null` from CDP but may reach the page as
      // `undefined` through `chrome.scripting`, which does not keep nulls nested in
      // arguments. Every empty form means the same thing.
      const own = field.selector === null || field.selector === undefined || field.selector === '';
      const target = own ? item : item.querySelector(field.selector);
      if (target === null) {
        record[field.name] = null;
        continue;
      }
      if (field.attribute === 'text') {
        record[field.name] = target.textContent ?? '';
      } else if (field.attribute === 'html') {
        record[field.name] = target.innerHTML;
      } else if (field.attribute === 'href' || field.attribute === 'src') {
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
  });
}

// ─── Used only from the injected module ─────────────────────────────────────

/** An element as data. Text is raw; the Node side normalises it. */
export interface RawSnapshot {
  readonly tagName: string;
  readonly text: string;
  readonly html: string;
  readonly attributes: Record<string, string>;
  readonly view: ElementView;
}

/** Snapshots the first match (`first`) or every match of `selector`. */
export function snapshotElements(selector: string, first: boolean): RawSnapshot[] {
  const elements = first
    ? [document.querySelector(selector)].filter((el): el is Element => el !== null)
    : Array.from(document.querySelectorAll(selector));
  return elements.map((element) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      attributes[attribute.name] = attribute.value;
    }
    return {
      tagName: element.tagName.toLowerCase(),
      text: element.textContent ?? '',
      html: element.innerHTML,
      attributes,
      view: measureElement(element),
    };
  });
}

/**
 * Resolves once the page reached `state` and, when given, `selector` is attached.
 *
 * Event-driven: the load event and DOM mutations are listened for, never sampled on
 * a timer. Resolves `false` on timeout — the caller turns that into an error.
 */
export function waitForPage(
  state: 'domcontentloaded' | 'load' | 'networkidle',
  selector: string | null,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let observer: MutationObserver | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    const whenSelector = (): void => {
      if (selector === null || document.querySelector(selector) !== null) {
        finish(true);
        return;
      }
      observer = new MutationObserver(() => {
        if (document.querySelector(selector) !== null) finish(true);
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true });
    };

    // `networkidle` has no DOM equivalent; the load event is the closest milestone.
    const loaded =
      state === 'domcontentloaded'
        ? document.readyState !== 'loading'
        : document.readyState === 'complete';
    if (loaded) {
      whenSelector();
    } else {
      const event = state === 'domcontentloaded' ? 'DOMContentLoaded' : 'load';
      (state === 'domcontentloaded' ? document : window).addEventListener(event, whenSelector, {
        once: true,
      });
    }
  });
}

/**
 * Clicks the first match of `selector`, the way a person's click reaches it: the
 * element is scrolled into view, then activated. The caller has already checked it
 * is human-interactable.
 *
 * @returns false when nothing matches.
 */
export function clickElement(selector: string): boolean {
  const element = document.querySelector(selector);
  if (element === null) return false;
  element.scrollIntoView({ block: 'center', inline: 'center' });
  (element as HTMLElement).click();
  return true;
}

export function scrollPage(direction: 'up' | 'down' | 'top' | 'bottom'): void {
  const step = window.innerHeight * 0.9;
  if (direction === 'top') window.scrollTo({ top: 0 });
  else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight });
  else window.scrollBy({ top: direction === 'down' ? step : -step });
}

export function pageText(): string {
  return document.body === null ? '' : document.body.innerText;
}

export function pageContent(): string {
  const doctype = document.doctype === null ? '' : `<!DOCTYPE ${document.doctype.name}>`;
  return doctype + document.documentElement.outerHTML;
}

/** Where an element sits in the viewport, in device pixels, for cropping a capture. */
export function elementBox(
  selector: string,
): { x: number; y: number; width: number; height: number } | null {
  const element = document.querySelector(selector);
  if (element === null) return null;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  const ratio = window.devicePixelRatio;
  return {
    x: Math.round(rect.left * ratio),
    y: Math.round(rect.top * ratio),
    width: Math.max(1, Math.round(rect.width * ratio)),
    height: Math.max(1, Math.round(rect.height * ratio)),
  };
}

/** The response of a fetch made by the page itself, with the page's own cookies. */
export interface PageFetchResult {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
}

/**
 * Fetches `url` from inside the page, so cookies and `SameSite` rules are exactly
 * those of the page — the same session a person's click would use.
 */
export async function fetchInPage(url: string, timeoutMs: number): Promise<PageFetchResult> {
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { url: response.url, status: response.status, headers, bodyBase64: btoa(binary) };
}
