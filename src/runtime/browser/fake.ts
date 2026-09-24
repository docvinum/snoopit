/**
 * A browser backend backed by a parsed DOM instead of a browser.
 *
 * This is not a stub that returns canned answers: it parses real HTML and runs real
 * selectors, so extraction specs, interactability rules and navigation semantics are
 * exercised for real — just without a browser process, a network, or a clock.
 *
 * It is shipped rather than confined to the test folder because workflow authors
 * need it too: a workflow test should assert on extraction logic, not on whether
 * Chrome started.
 *
 * What it deliberately does *not* model: layout. Every element's box is declared by
 * the fixture through `data-fake-*` attributes rather than computed, because
 * modelling layout badly would be worse than not modelling it.
 */

import { parseHTML } from 'linkedom';
import { canonicalizeUrl } from '../navigation/canonical.js';
import {
  normalizeText,
  parseExtractSpec,
  type ExtractedRecord,
  type ExtractSpec,
  type FieldMap,
} from '../extraction/spec.js';
import { HTML_PSEUDO_ATTRIBUTE, TEXT_PSEUDO_ATTRIBUTE } from '../extraction/spec.js';
import { isHumanInteractable, type ElementView } from './interactable.js';
import {
  ElementNotFoundError,
  NotInteractableError,
  type BrowserBackend,
  type ClickOptions,
  type ElementSnapshot,
  type FetchResult,
  type NavigationResult,
  type OpenOptions,
  type PageHandle,
  type ReadyOptions,
  type ScreenshotOptions,
} from './types.js';

/** linkedom's document is DOM-compatible, so the rest of the file is plain DOM code. */
function parseDocument(html: string): Document {
  const document = parseHTML(html).document;
  // A body that is not HTML (`boom`, a plain-text error) parses to a document with
  // no root. Chrome shows such a body inside a document of its own; so does the
  // fake, or any query against an error page would crash here and nowhere else.
  if ((document.documentElement as Element | null) !== null) return document;
  const text = html.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return parseHTML(`<html><body><pre>${text}</pre></body></html>`).document;
}

/** One HTTP response the fake knows how to serve. */
export interface FakeResponse {
  readonly status?: number;
  readonly body?: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  /** Absolute or relative Location, making this a redirect. */
  readonly redirectTo?: string;
}

export interface FakeSite {
  /** Keyed by canonical URL. */
  readonly routes: Readonly<Record<string, FakeResponse>>;
}

/** Records what a workflow did, so tests can assert on behaviour, not just output. */
export interface FakeJournalEntry {
  readonly action: 'navigate' | 'click' | 'fetch' | 'screenshot' | 'wait' | 'scroll';
  readonly target: string;
}

const NOT_FOUND: FakeResponse = { status: 404, body: '<html><body>Not Found</body></html>' };

function mediaTypeOf(headers: Readonly<Record<string, string>>): string | null {
  const raw = headers['content-type'];
  return raw === undefined ? null : (raw.split(';')[0]?.trim() ?? null);
}

/** Reads a boolean-ish `data-fake-*` attribute. */
function fakeFlag(element: Element, name: string): boolean {
  const value = element.getAttribute(`data-fake-${name}`);
  return value !== null && value !== 'false';
}

function fakeNumber(element: Element, name: string, fallback: number): number {
  const value = element.getAttribute(`data-fake-${name}`);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** True when the element or any ancestor satisfies `predicate`. */
function inheritedFlag(element: Element, predicate: (el: Element) => boolean): boolean {
  let current: Element | null = element;
  while (current !== null) {
    if (predicate(current)) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * Derives an `ElementView` from the DOM plus fixture hints.
 *
 * Inline `style` is read for the properties that matter to interactability, and
 * `data-fake-width` / `data-fake-height` / `data-fake-reachable` stand in for
 * layout. A fixture states its geometry; it is never guessed.
 */
function viewOf(element: Element): ElementView {
  const style = element.getAttribute('style') ?? '';
  const styleProp = (name: string): string | null => {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style);
    return match === null ? null : match[1]!.trim().toLowerCase();
  };

  const display = styleProp('display') ?? 'block';
  const visibility = styleProp('visibility') ?? 'visible';
  const opacityRaw = styleProp('opacity');
  const opacity = opacityRaw === null ? 1 : Number(opacityRaw);
  const pointerEvents = styleProp('pointer-events') ?? 'auto';

  // A `display:none` ancestor hides the element too — cheap to honour, and the most
  // common way a cookie banner "disappears".
  const hiddenByAncestor = inheritedFlag(element, (el) => {
    const s = el.getAttribute('style') ?? '';
    return /(?:^|;)\s*display\s*:\s*none/i.test(s);
  });

  return {
    width: fakeNumber(element, 'width', 120),
    height: fakeNumber(element, 'height', 32),
    display: hiddenByAncestor ? 'none' : display,
    visibility,
    opacity: Number.isFinite(opacity) ? opacity : 1,
    pointerEvents,
    ariaHidden: inheritedFlag(element, (el) => el.getAttribute('aria-hidden') === 'true'),
    inert: inheritedFlag(element, (el) => el.hasAttribute('inert')),
    hidden: inheritedFlag(element, (el) => el.hasAttribute('hidden')),
    disabled: element.hasAttribute('disabled'),
    reachable: !fakeFlag(element, 'unreachable'),
  };
}

function attributesOf(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    attributes[attr.name] = attr.value;
  }
  return attributes;
}

function snapshotOf(element: Element, selector: string): ElementSnapshot {
  return {
    selector,
    tagName: element.tagName.toLowerCase(),
    text: normalizeText(element.textContent ?? ''),
    html: element.innerHTML,
    attributes: attributesOf(element),
    view: viewOf(element),
  };
}

/** Reads one field off an item, resolving `href`/`src` against the page URL. */
function readField(
  item: Element,
  field: { selector: string | null; attribute: string },
  pageUrl: string,
): string | null {
  const target = field.selector === null ? item : item.querySelector(field.selector);
  if (target === null) return null;

  if (field.attribute === TEXT_PSEUDO_ATTRIBUTE) {
    return normalizeText(target.textContent ?? '');
  }
  if (field.attribute === HTML_PSEUDO_ATTRIBUTE) {
    return target.innerHTML;
  }

  const value = target.getAttribute(field.attribute);
  if (value === null) return null;

  // URL-bearing attributes come back absolute: a workflow should never have to
  // remember which page a relative href was found on.
  if (field.attribute === 'href' || field.attribute === 'src') {
    const resolved = canonicalizeUrl(value, { base: pageUrl });
    return resolved.ok ? resolved.canonical : value;
  }
  return value;
}

class FakePage implements PageHandle {
  private currentUrl = 'about:blank';
  private currentStatus: number | null = null;
  private currentRedirects: string[] = [];
  private document: Document;
  private closed = false;

  constructor(
    private readonly site: FakeSite,
    private readonly journal: FakeJournalEntry[],
  ) {
    this.document = parseDocument('<html><body></body></html>');
  }

  url(): string {
    return this.currentUrl;
  }

  status(): number | null {
    return this.currentStatus;
  }

  redirectChain(): readonly string[] {
    return this.currentRedirects;
  }

  /**
   * Resolves a URL through the fake's redirect chain, guarding against loops.
   *
   * Routes are *looked up* by canonical URL, but the URL the page reports is the
   * real one. A browser does not canonicalise its address bar, and neither may the
   * fake: canonicalisation is the state layer's identity function, not a
   * navigation behaviour. Conflating the two made `/index.html` report as `/`.
   */
  private resolve(url: string): {
    finalUrl: string;
    response: FakeResponse;
    chain: string[];
  } {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = FakePage.absolute(url, this.currentUrl);

    for (let hop = 0; hop < 10; hop += 1) {
      const key = canonicalizeUrl(current);
      const lookup = key.ok ? key.canonical : current;
      if (seen.has(lookup)) throw new Error(`Redirect loop at ${current}`);
      seen.add(lookup);

      const response = this.site.routes[lookup] ?? NOT_FOUND;
      if (response.redirectTo === undefined) {
        return { finalUrl: current, response, chain };
      }
      chain.push(current);
      current = FakePage.absolute(response.redirectTo, current);
    }
    throw new Error(`Too many redirects starting at ${url}`);
  }

  /** Resolves a possibly-relative URL against a base, without canonicalising. */
  private static absolute(url: string, base: string): string {
    try {
      return base === 'about:blank' ? new URL(url).href : new URL(url, base).href;
    } catch {
      return url;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Page is closed');
  }

  navigate(url: string): Promise<NavigationResult> {
    this.assertOpen();
    this.journal.push({ action: 'navigate', target: url });

    const { finalUrl, response, chain } = this.resolve(url);
    const status = response.status ?? 200;
    const body = response.body ?? '';

    this.currentUrl = finalUrl;
    this.currentStatus = status;
    this.currentRedirects = chain;
    this.document = parseDocument(typeof body === 'string' ? body : body.toString('utf8'));

    return Promise.resolve({
      url: finalUrl,
      status,
      redirectChain: chain,
      ok: status >= 200 && status < 400,
    });
  }

  waitForReady(options: ReadyOptions = {}): Promise<void> {
    this.assertOpen();
    this.journal.push({ action: 'wait', target: options.selector ?? options.state ?? 'load' });

    // The fake has no clock: content is either present now or it never will be.
    if (options.selector !== undefined && this.document.querySelector(options.selector) === null) {
      return Promise.reject(new ElementNotFoundError(options.selector));
    }
    return Promise.resolve();
  }

  query(selector: string): Promise<ElementSnapshot | null> {
    this.assertOpen();
    const element = this.document.querySelector(selector);
    return Promise.resolve(element === null ? null : snapshotOf(element, selector));
  }

  queryAll(selector: string): Promise<ElementSnapshot[]> {
    this.assertOpen();
    return Promise.resolve(
      Array.from(this.document.querySelectorAll(selector)).map((el) => snapshotOf(el, selector)),
    );
  }

  extractAll<F extends FieldMap>(spec: ExtractSpec<F>): Promise<ExtractedRecord<F>[]> {
    this.assertOpen();
    const fields = parseExtractSpec(spec);
    const items = Array.from(this.document.querySelectorAll(spec.selector));

    return Promise.resolve(
      items.map((item) => {
        const record: Record<string, string | null> = {};
        for (const [name, field] of fields) {
          record[name] = readField(item, field, this.currentUrl);
        }
        return record as ExtractedRecord<F>;
      }),
    );
  }

  click(selector: string, options: ClickOptions = {}): Promise<void> {
    this.assertOpen();
    const element = this.document.querySelector(selector);
    if (element === null) return Promise.reject(new ElementNotFoundError(selector));

    if (options.force !== true) {
      const verdict = isHumanInteractable(viewOf(element));
      if (!verdict.interactable) {
        return Promise.reject(new NotInteractableError(selector, verdict.reasons));
      }
    }

    this.journal.push({ action: 'click', target: selector });

    // Two effects are modelled because workflows depend on them: following a link,
    // and the `data-fake-hides` dismissal used by overlay heuristics.
    const hides = element.getAttribute('data-fake-hides');
    if (hides !== null) {
      for (const target of Array.from(this.document.querySelectorAll(hides))) {
        target.setAttribute('style', `${target.getAttribute('style') ?? ''};display:none`);
      }
    }

    // The symmetric case: dismissing an overlay usually reveals what it covered.
    const shows = element.getAttribute('data-fake-shows');
    if (shows !== null) {
      for (const target of Array.from(this.document.querySelectorAll(shows))) {
        const style = (target.getAttribute('style') ?? '').replace(/display\s*:\s*none;?/gi, '');
        target.setAttribute('style', `${style};display:block`);
      }
    }

    const href = element.getAttribute('href');
    if (href !== null && !href.startsWith('#')) {
      const resolved = canonicalizeUrl(href, { base: this.currentUrl });
      if (resolved.ok) return this.navigate(resolved.canonical).then(() => undefined);
    }
    return Promise.resolve();
  }

  /**
   * A no-op: the fake models a DOM, not a layout, so there is no viewport to move.
   *
   * Deliberately not faked with a `data-fake-*` hint — pretending to scroll would
   * make a scroll-dependent test pass here while failing in a real browser, which is
   * worse than not covering it. Scroll behaviour is verified against Chrome.
   */
  scroll(): Promise<void> {
    this.assertOpen();
    this.journal.push({ action: 'scroll', target: 'page' });
    return Promise.resolve();
  }

  content(): Promise<string> {
    this.assertOpen();
    return Promise.resolve(this.document.documentElement?.outerHTML ?? '');
  }

  text(): Promise<string> {
    this.assertOpen();
    return Promise.resolve(normalizeText(this.document.body?.textContent ?? ''));
  }

  screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    this.assertOpen();
    this.journal.push({ action: 'screenshot', target: options.selector ?? 'page' });
    // A stable, valid 1x1 PNG: enough to exercise the artifact pipeline end to end.
    return Promise.resolve(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
  }

  fetch(url: string): Promise<FetchResult> {
    this.assertOpen();
    this.journal.push({ action: 'fetch', target: url });

    const absolute = canonicalizeUrl(url, { base: this.currentUrl });
    const { finalUrl, response } = this.resolve(absolute.ok ? absolute.canonical : url);
    const headers = response.headers ?? {};
    const body = response.body ?? '';

    return Promise.resolve({
      url: finalUrl,
      status: response.status ?? 200,
      headers,
      body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
      mediaType: mediaTypeOf(headers),
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export class FakeBackend implements BrowserBackend {
  /** Every action taken through this backend, in order. */
  readonly journal: FakeJournalEntry[] = [];

  constructor(private readonly site: FakeSite) {}

  async open(url: string, options?: OpenOptions): Promise<PageHandle> {
    const page = await this.newPage(options);
    await page.navigate(url);
    return page;
  }

  newPage(_options?: OpenOptions): Promise<PageHandle> {
    return Promise.resolve(new FakePage(this.site, this.journal));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
