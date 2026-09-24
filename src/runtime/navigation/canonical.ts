/**
 * URL canonicalisation — the identity function of the whole system.
 *
 * `(job_id, canonical_url)` is the primary key of a page and of a frontier entry.
 * Everything that makes resumption robust — deduplication, "have I seen this?",
 * "did this change?" — reduces to this function being stable and total.
 *
 * Two properties matter more than cleverness:
 *
 *  - **Deterministic.** The same input always yields the same output. No clock, no
 *    network, no I/O. That is what makes it exhaustively unit-testable, and it is
 *    the first thing Lot 1 proves.
 *  - **Conservative.** A wrong merge (two distinct pages collapsing into one) loses
 *    data silently, which is far worse than a wrong split (one page counted twice),
 *    which merely costs a visit. Where a rule is ambiguous, we do not merge.
 *
 * That asymmetry is why `www.` stripping is off by default: `www.example.com` and
 * `example.com` are usually the same host, but when they are not, the damage is
 * invisible. It is opt-in per job instead.
 */

/** Query parameters that identify a marketing campaign rather than a resource. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'ttclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'epik',
  's_kwcid',
  'ef_id',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_anon_id',
  'oly_enc_id',
]);

/** Prefixes whose every parameter is tracking (`utm_source`, `hsa_cam`, ...). */
const TRACKING_PREFIXES: readonly string[] = ['utm_', 'hsa_'];

/** Directory index filenames that address the same resource as their directory. */
const INDEX_FILENAMES: ReadonlySet<string> = new Set([
  'index.html',
  'index.htm',
  'index.php',
  'default.html',
  'default.htm',
]);

const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

export interface CanonicalizeOptions {
  /** Base URL used to resolve relative hrefs, e.g. the page the link was found on. */
  readonly base?: string;
  /**
   * Treat `www.example.com` and `example.com` as the same host.
   * Off by default — see the module note on conservative merging.
   */
  readonly stripWww?: boolean;
  /** Drop a trailing slash on non-root paths (`/a/b/` -> `/a/b`). Default: true. */
  readonly stripTrailingSlash?: boolean;
  /** Rewrite `/docs/index.html` to `/docs`. Default: true. */
  readonly stripIndexFiles?: boolean;
  /** Additional parameter names to drop, on top of the built-in tracking list. */
  readonly extraTrackingParams?: readonly string[];
  /** Parameter names to keep even if they look like tracking. Wins over every rule. */
  readonly keepParams?: readonly string[];
}

export type CanonicalizeFailure = 'invalid-url' | 'unsupported-scheme' | 'empty';

export type CanonicalizeResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: CanonicalizeFailure; readonly input: string };

function isTrackingParam(name: string, extra: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower) || extra.has(lower)) return true;
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function normalizePath(pathname: string, options: CanonicalizeOptions): string {
  let path = pathname;

  if (options.stripIndexFiles !== false) {
    const lastSlash = path.lastIndexOf('/');
    const filename = path.slice(lastSlash + 1).toLowerCase();
    if (INDEX_FILENAMES.has(filename)) {
      path = path.slice(0, lastSlash + 1);
    }
  }

  if (options.stripTrailingSlash !== false && path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '');
    if (path === '') path = '/';
  }

  return path === '' ? '/' : path;
}

/**
 * Canonicalises a URL, resolving it against `options.base` when relative.
 *
 * Returns a result rather than throwing: a crawl walks over malformed hrefs
 * (`javascript:`, `mailto:`, `#`, plain garbage) constantly, and those are normal
 * input to be recorded and skipped, not exceptional conditions.
 */
export function canonicalizeUrl(
  input: string,
  options: CanonicalizeOptions = {},
): CanonicalizeResult {
  const raw = input.trim();
  if (raw === '' || raw === '#') {
    return { ok: false, reason: 'empty', input };
  }

  let url: URL;
  try {
    url = options.base === undefined ? new URL(raw) : new URL(raw, options.base);
  } catch {
    return { ok: false, reason: 'invalid-url', input };
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: 'unsupported-scheme', input };
  }

  // The URL parser already lowercases the scheme and host, drops the default port,
  // and resolves `.`/`..` segments. We only handle what it deliberately preserves.
  url.hash = '';
  url.username = '';
  url.password = '';

  if (options.stripWww === true && url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
  }

  url.pathname = normalizePath(url.pathname, options);

  const extra = new Set((options.extraTrackingParams ?? []).map((p) => p.toLowerCase()));
  const keep = new Set((options.keepParams ?? []).map((p) => p.toLowerCase()));

  const params: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (keep.has(name.toLowerCase()) || !isTrackingParam(name, extra)) {
      params.push([name, value]);
    }
  }

  // Sorting makes `?b=2&a=1` and `?a=1&b=2` the same key. Ties are broken on the
  // value so repeated keys (`?tag=x&tag=y`) also order deterministically.
  params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));

  url.search = '';
  for (const [name, value] of params) {
    url.searchParams.append(name, value);
  }

  // `url.href` keeps a bare `?` when the query is empty; strip it.
  const href = url.href;
  return { ok: true, canonical: href.endsWith('?') ? href.slice(0, -1) : href };
}

/** Canonicalises, returning `null` instead of a reason. For call sites that only filter. */
export function tryCanonicalizeUrl(
  input: string,
  options: CanonicalizeOptions = {},
): string | null {
  const result = canonicalizeUrl(input, options);
  return result.ok ? result.canonical : null;
}

/** Canonicalises, throwing on failure. For call sites where a bad URL is a real bug. */
export function canonicalizeUrlOrThrow(input: string, options: CanonicalizeOptions = {}): string {
  const result = canonicalizeUrl(input, options);
  if (!result.ok) {
    throw new Error(`canonicalizeUrl: ${result.reason} for "${input}"`);
  }
  return result.canonical;
}

/** Scheme + host + port of a URL, or `null` if it cannot be parsed. */
export function originOf(input: string, base?: string): string | null {
  try {
    return (base === undefined ? new URL(input) : new URL(input, base)).origin;
  } catch {
    return null;
  }
}

/** True when both URLs parse and share an origin. */
export function isSameOrigin(a: string, b: string): boolean {
  const originA = originOf(a);
  return originA !== null && originA === originOf(b);
}

/**
 * The host a URL belongs to, for "did we leave the site?" questions: lowercased,
 * a leading `www.` dropped, port ignored. `www.example.com` and `example.com` are
 * one site; `auth.example.com` is not the same *place* — and a redirect there is
 * precisely what a login wall looks like.
 *
 * @returns `null` when the URL does not parse.
 */
export function siteHost(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Applies a page's declared `<link rel="canonical">`.
 *
 * A cross-origin canonical link is ignored on purpose. Honouring it would let any
 * page reassign its identity to a host we are not crawling — collapsing unrelated
 * pages together, the exact failure mode this module is built to avoid.
 */
export function applyCanonicalLink(
  pageUrl: string,
  declaredHref: string | null | undefined,
  options: CanonicalizeOptions = {},
): CanonicalizeResult {
  const pageResult = canonicalizeUrl(pageUrl, options);
  if (declaredHref === null || declaredHref === undefined || declaredHref.trim() === '') {
    return pageResult;
  }
  if (!pageResult.ok) return pageResult;

  const declared = canonicalizeUrl(declaredHref, { ...options, base: pageUrl });
  if (!declared.ok) return pageResult;

  return isSameOrigin(declared.canonical, pageResult.canonical) ? declared : pageResult;
}
