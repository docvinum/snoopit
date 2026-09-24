/**
 * The workflow context implementation.
 *
 * This is where a workflow's intentions become durable state. Every method that
 * changes what we know about the world writes to SQLite and emits an event, in that
 * order, so a run can always be reconstructed from the record rather than from logs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BrowserBackend, PageHandle } from '../browser/types.js';
import type { ExtractedRecord, ExtractSpec, FieldMap } from '../extraction/spec.js';
import { canonicalizeUrl, siteHost } from '../navigation/canonical.js';
import { AuthRequiredError, detectLoginWall } from '../navigation/session.js';
import { BlockedError } from '../recovery/blocking.js';
import { fetchDownload, writeDownload } from '../downloads/download.js';
import { artifactPath, versionedPath } from '../downloads/paths.js';
import type { RunEventEmitter } from '../events/emitter.js';
import type { BudgetGuard } from '../budget/guard.js';
import type { Store } from '../../state/store.js';
import type {
  Artifact,
  FrontierEntry,
  Item,
  ItemChange,
  ItemFields,
  ItemStatus,
  Job,
  Run,
} from '../../state/types.js';
import { contentHash } from '../../util/hash.js';
import { isoFromNow, parseDuration } from '../../util/time.js';
import { enqueueDueRevisits } from '../../scheduler/revisit.js';
import { dismissOverlays, type DismissResult } from '../recovery/heuristics.js';
import {
  probeBlocking,
  recover,
  type RecoverOptions,
  type RecoveryOutcome,
} from '../recovery/recover.js';
import type { LlmProvider } from '../recovery/llm/provider.js';
import type {
  CollectOptions,
  CollectResult,
  DiscoverOptions,
  ItemObservation,
  VisitOptions,
  VisitResult,
  WorkflowContext,
} from './types.js';

export interface ContextOptions {
  readonly store: Store;
  readonly job: Job;
  readonly run: Run;
  readonly browser: BrowserBackend;
  readonly events: RunEventEmitter;
  /** Absolute path of the data directory. */
  readonly dataDir: string;
  /** Lease duration for frontier entries claimed by this run. */
  readonly leaseMs?: number;
  readonly budget: BudgetGuard;
  /** Hard cap on frontier entries this run may claim, from `pagesPerRun`. */
  readonly pagesPerRun?: number | null;
  /** Absent means recovery stops at L1 — a valid, fully supported configuration. */
  readonly llm?: LlmProvider | null;
}

const DEFAULT_LEASE_MS = 15 * 60_000;

/** Text used to detect change. Body text, not raw HTML: markup churn is not change. */
function hashOfPageText(text: string): string {
  return contentHash(text);
}

export class RunContext implements WorkflowContext {
  readonly job: Job;
  readonly run: Run;
  readonly browser: BrowserBackend;
  readonly events: RunEventEmitter;
  readonly budget: BudgetGuard;

  private readonly store: Store;
  private readonly dataDir: string;
  private readonly leaseMs: number;
  private readonly pagesPerRun: number | null;
  private readonly llm: LlmProvider | null;
  /** Frontier entries claimed so far, so `pagesPerRun` bounds the whole run. */
  private claimed = 0;

  constructor(options: ContextOptions) {
    this.store = options.store;
    this.job = options.job;
    this.run = options.run;
    this.browser = options.browser;
    this.events = options.events;
    this.dataDir = options.dataDir;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.budget = options.budget;
    this.pagesPerRun = options.pagesPerRun ?? null;
    this.llm = options.llm ?? null;
  }

  private canonical(url: string, base?: string): string {
    const result = canonicalizeUrl(url, base === undefined ? {} : { base });
    if (!result.ok) throw new Error(`Unusable URL "${url}": ${result.reason}`);
    return result.canonical;
  }

  async visit(url: string, options: VisitOptions = {}): Promise<VisitResult> {
    // Asked before acting: `maxPages: 10` means the eleventh visit never starts.
    // The runner turns this into a clean stop, not a failure.
    this.budget.assertOk('page');

    const canonicalUrl = this.canonical(url);
    const page = await this.browser.open(url, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });

    const navigation = {
      url: page.url(),
      status: page.status(),
      redirectChain: page.redirectChain(),
      ok: page.status() === null ? true : page.status()! >= 200 && page.status()! < 400,
    };

    // A refusal or a lost session is checked *before* anything is recorded: the
    // challenge page or the login form must never be stored as this URL's content.
    await this.assertAccess(page, url, canonicalUrl, navigation.ok, options);

    if (options.waitFor !== undefined) {
      try {
        await page.waitForReady({
          selector: options.waitFor,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        // A client-side redirect or a challenge injected after `load` shows up here
        // as a missing selector. The more specific explanation wins over a timeout.
        await this.assertAccess(page, url, canonicalUrl, navigation.ok, options);
        throw error;
      }
    }

    if (options.record === false) {
      return { page, navigation, record: null, changed: false, firstVisit: false, offSite: false };
    }

    // Landing on another site is not a visit of this URL. Hashing whatever answered
    // there would report the page as changed when it is merely elsewhere.
    const requestedHost = siteHost(url);
    const finalHost = siteHost(navigation.url);
    const expectedHost =
      options.session?.expectHost === undefined
        ? null
        : siteHost(`https://${options.session.expectHost}`);
    if (navigation.ok && finalHost !== requestedHost && finalHost !== expectedHost) {
      const record = this.store.pages.recordError({
        jobId: this.job.id,
        url,
        canonicalUrl,
        error: `redirected off-site to ${finalHost ?? navigation.url}`,
        httpStatus: navigation.status,
      });
      // A unit of crawl work all the same: a loop of off-site redirects stays bounded.
      this.budget.recordPage();
      this.events.emit({
        type: 'HTTP_ERROR',
        level: 'warn',
        url,
        canonicalUrl,
        message: `Redirigé hors site vers ${navigation.url}`,
        data: { status: navigation.status, redirectChain: navigation.redirectChain },
      });
      return { page, navigation, record, changed: false, firstVisit: false, offSite: true };
    }

    // A failed fetch is recorded as an error against the page, never as a visit:
    // hashing a 404 body would make the error look like content that "changed".
    if (!navigation.ok) {
      const status = navigation.status;

      // `gone` and `error` are different findings, and the more specific one wins.
      // A 404 says the resource is not there; `error` is for transport failures we
      // may retry. Recording both would let the vaguer status overwrite the useful
      // one, and a disappeared page would become indistinguishable from a timeout.
      let record;
      if (status === 404 || status === 410) {
        // markGone only updates, so a URL navigated to directly — never discovered —
        // needs its row created first.
        this.store.pages.discover({ jobId: this.job.id, url, canonicalUrl });
        record = this.store.pages.markGone(this.job.id, canonicalUrl, status);
      } else {
        record = this.store.pages.recordError({
          jobId: this.job.id,
          url,
          canonicalUrl,
          error: `HTTP ${String(status ?? 0)}`,
          httpStatus: status,
        });
      }

      // Either way it counts against the run's error budget: both are things an
      // audit reports and `maxErrors` is meant to bound.
      this.store.runs.increment(this.run.id, 'errorCount');
      this.budget.recordError();
      this.events.emit({
        type: 'HTTP_ERROR',
        level: 'error',
        url,
        canonicalUrl,
        message: `HTTP ${String(status ?? 0)}`,
        data: { status, redirectChain: navigation.redirectChain },
      });

      return { page, navigation, record, changed: false, firstVisit: false, offSite: false };
    }

    const title = (await page.query('title'))?.text ?? null;
    const visit = this.store.pages.recordVisit({
      jobId: this.job.id,
      url,
      canonicalUrl,
      contentHash: hashOfPageText(await page.text()),
      httpStatus: navigation.status,
      title,
      nextVisitAfter:
        options.revisitAfter === undefined ? null : isoFromNow(parseDuration(options.revisitAfter)),
    });

    this.store.runs.increment(this.run.id, 'pagesVisited');
    this.budget.recordPage();
    this.events.emit({
      type: 'PAGE_VISITED',
      url: navigation.url,
      canonicalUrl,
      ...(title === null ? {} : { message: title }),
      data: { status: navigation.status, redirectChain: navigation.redirectChain },
    });

    if (visit.changed) {
      this.events.emit({
        type: 'CONTENT_CHANGED',
        url: navigation.url,
        canonicalUrl,
        message: 'Content hash differs from the previous visit',
      });
    }

    return {
      page,
      navigation,
      record: visit.page,
      changed: visit.changed,
      firstVisit: visit.firstVisit,
      offSite: false,
    };
  }

  /**
   * Stops the run when the site refuses us or the session is gone.
   *
   * Widgets are always probed; page wording only when the answer was already an
   * error status, where a challenge page is likely and an article merely
   * mentioning "captcha" is not. The page is closed before throwing: nothing
   * further will be done with it.
   */
  private async assertAccess(
    page: PageHandle,
    url: string,
    canonicalUrl: string,
    ok: boolean,
    options: VisitOptions,
  ): Promise<void> {
    const signal = await probeBlocking(page, { text: !ok });
    if (signal !== null) {
      this.store.pages.recordError({
        jobId: this.job.id,
        url,
        canonicalUrl,
        error: `blocked: ${signal.reason}`,
        httpStatus: page.status(),
      });
      await page.close();
      throw new BlockedError(url, signal);
    }

    const session = options.session;
    if (session === undefined) return;
    const evidence = detectLoginWall({
      finalUrl: page.url(),
      expectation: session,
      loginSelectorPresent:
        session.loginSelector !== undefined && (await page.query(session.loginSelector)) !== null,
    });
    if (evidence !== null) {
      const finalUrl = page.url();
      await page.close();
      throw new AuthRequiredError(url, finalUrl, evidence);
    }
  }

  readonly frontier = {
    discover: (url: string, options: DiscoverOptions = {}): boolean => {
      const canonicalUrl = this.canonical(url);
      const added = this.store.frontier.enqueue({
        jobId: this.job.id,
        url,
        canonicalUrl,
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      });

      if (added) {
        this.store.pages.discover({ jobId: this.job.id, url, canonicalUrl });
        this.store.runs.increment(this.run.id, 'pagesDiscovered');
        this.events.emit({ type: 'PAGE_DISCOVERED', url, canonicalUrl });
      }
      return added;
    },

    discoverAll: (urls: readonly string[], options: DiscoverOptions = {}): number =>
      urls.reduce((added, url) => added + (this.frontier.discover(url, options) ? 1 : 0), 0),

    take: (limit: number): FrontierEntry[] => {
      // Never claim work this run is not allowed to finish: a leased entry that is
      // abandoned costs a lease expiry before anyone can pick it up again.
      const caps = [limit, this.budget.remaining('max_pages')];
      if (this.pagesPerRun !== null) caps.push(this.pagesPerRun - this.claimed);

      const effective = Math.min(...caps.filter((cap): cap is number => cap !== null));
      if (effective <= 0) return [];

      const entries = this.store.frontier.lease({
        jobId: this.job.id,
        runId: this.run.id,
        limit: effective,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
      });
      this.claimed += entries.length;
      return entries;
    },

    complete: (entry: FrontierEntry): void => {
      this.store.frontier.complete(this.job.id, entry.canonicalUrl);
    },

    fail: (entry: FrontierEntry, error: string): void => {
      this.store.frontier.fail(this.job.id, entry.canonicalUrl, error);
      this.store.runs.increment(this.run.id, 'errorCount');
      this.budget.recordError();
    },

    remaining: (): number => this.store.frontier.remaining(this.job.id),

    enqueueDueRevisits: (options: { limit?: number; includeGone?: boolean } = {}): number =>
      enqueueDueRevisits(this.store, {
        jobId: this.job.id,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.includeGone === undefined ? {} : { includeGone: options.includeGone }),
      }),
  };

  readonly artifacts = {
    collect: async (
      page: PageHandle,
      url: string,
      options: CollectOptions = {},
    ): Promise<CollectResult> => {
      // Both limits apply: a collected document costs a unit of crawl work and a
      // number of bytes.
      this.budget.assertOk('page');
      this.budget.assertOk('download');
      const canonicalUrl = this.canonical(url, page.url());
      const fetched = await fetchDownload(page, url, {
        jobId: this.job.id,
        ...(options.dir === undefined ? {} : { dir: options.dir }),
        ...(options.filename === undefined ? {} : { filename: options.filename }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      // The fetch happened whatever comes next, so it is charged whatever comes
      // next. Charging only new artifacts would leave a workflow that re-collects
      // known documents bounded by nothing.
      this.store.runs.increment(this.run.id, 'downloadedBytes', fetched.bytes);
      this.budget.recordBytes(fetched.bytes);
      this.budget.recordPage();

      // Content-addressed deduplication: the same bytes, at this URL or republished
      // at another one, are not a second artifact. Checked before anything is
      // written, so an existing file is never touched.
      if (options.dedupe !== false) {
        const existing = this.store.artifacts.findByHash(this.job.id, fetched.contentHash);
        const match = existing.find((candidate) => candidate.path === fetched.path) ?? existing[0];
        if (match !== undefined) {
          return { artifact: match, deduplicated: true };
        }
      }

      // Different bytes at a path an earlier artifact already owns: a new version,
      // stored next to the old one. Overwriting would leave the earlier artifact's
      // hash describing a file that no longer exists.
      const owners = this.store.artifacts.findByPath(this.job.id, fetched.path);
      const path = owners.every((owner) => owner.contentHash === fetched.contentHash)
        ? fetched.path
        : versionedPath(fetched.path, fetched.contentHash);
      await writeDownload(this.dataDir, path, fetched.body);

      const pageRow = this.store.pages.get(this.job.id, canonicalUrl);
      const artifact = this.store.artifacts.create({
        jobId: this.job.id,
        runId: this.run.id,
        pageId: pageRow?.id ?? null,
        sourceUrl: fetched.url,
        canonicalUrl,
        kind: fetched.mediaType === 'application/pdf' ? 'pdf' : 'file',
        path,
        mediaType: fetched.mediaType,
        bytes: fetched.bytes,
        contentHash: fetched.contentHash,
      });

      this.store.runs.increment(this.run.id, 'artifactsCreated');
      this.events.emit({
        type: 'ARTIFACT_CREATED',
        url: fetched.url,
        canonicalUrl,
        message: path,
        data: { bytes: fetched.bytes, mediaType: fetched.mediaType },
      });

      return { artifact, deduplicated: false };
    },

    writeJson: (name: string, data: unknown, options: { dir?: string } = {}): Promise<Artifact> =>
      this.writeArtifact(name, JSON.stringify(data, null, 2), 'json', 'application/json', options),

    writeMarkdown: (
      name: string,
      text: string,
      options: { dir?: string } = {},
    ): Promise<Artifact> => this.writeArtifact(name, text, 'markdown', 'text/markdown', options),

    screenshot: async (page: PageHandle, name: string): Promise<Artifact> => {
      const bytes = await page.screenshot({ fullPage: true });
      return this.writeArtifactBytes(name, bytes, 'screenshot', 'image/png', {
        dir: 'screenshots',
        sourceUrl: page.url(),
      });
    },
  };

  readonly items = {
    observe: (kind: string, key: string, fields: ItemFields): ItemObservation => {
      if (kind.trim() === '' || key.trim() === '') {
        throw new Error(`items.observe: kind and key are required (got "${kind}", "${key}")`);
      }
      const observation = this.store.items.observe({
        jobId: this.job.id,
        kind,
        key,
        fields,
        runId: this.run.id,
      });

      if (observation.status !== 'unchanged') {
        const type =
          observation.status === 'new'
            ? 'ITEM_NEW'
            : observation.status === 'returned'
              ? 'ITEM_RETURNED'
              : 'ITEM_CHANGED';
        const url = fields['url'];
        this.events.emit({
          type,
          ...(typeof url === 'string' ? { url } : {}),
          message: `${kind}:${key}`,
          data: { kind, key, ...(observation.status === 'new' ? {} : { diff: observation.diff }) },
        });
      }
      return observation;
    },

    markMissing: (kind: string): Item[] => {
      const gone = this.store.items.markMissing({
        jobId: this.job.id,
        kind,
        runId: this.run.id,
      });
      for (const item of gone) {
        const url = item.fields['url'];
        this.events.emit({
          type: 'ITEM_GONE',
          ...(typeof url === 'string' ? { url } : {}),
          message: `${kind}:${item.key}`,
          data: { kind, key: item.key },
        });
      }
      return gone;
    },

    get: (kind: string, key: string): Item | null => this.store.items.get(this.job.id, kind, key),

    list: (kind?: string, options: { status?: ItemStatus } = {}): Item[] =>
      this.store.items.list(this.job.id, {
        ...(kind === undefined ? {} : { kind }),
        ...(options.status === undefined ? {} : { status: options.status }),
      }),

    history: (kind: string, key: string): ItemChange[] => {
      const item = this.store.items.get(this.job.id, kind, key);
      return item === null ? [] : this.store.items.history(item.id);
    },
  };

  dismissOverlays(page: PageHandle): Promise<DismissResult> {
    return dismissOverlays(page);
  }

  async recover(page: PageHandle, options: RecoverOptions): Promise<RecoveryOutcome> {
    this.events.emit({
      type: 'RECOVERY_STARTED',
      level: 'warn',
      url: page.url(),
      message: options.goal,
      data: { expected: options.expectedState.selector },
    });

    try {
      const outcome = await recover(page, options, {
        llm: this.llm,
        // Each model call is checked against the run's LLM budget before it is made,
        // so a recovery loop cannot quietly become the run's main cost.
        onLlmCall: () => {
          this.budget.assertOk('llm');
          this.budget.recordLlmCall();
          this.store.runs.increment(this.run.id, 'llmCalls');
        },
      });

      this.events.emit({
        type: 'RECOVERY_SUCCEEDED',
        url: page.url(),
        message: `${options.goal} — ${outcome.level ?? 'already in state'}`,
        data: { level: outcome.level, llmCalls: outcome.llmCalls, steps: outcome.steps },
      });
      return outcome;
    } catch (error) {
      this.events.emit({
        type: 'RECOVERY_FAILED',
        level: 'error',
        url: page.url(),
        message: error instanceof Error ? error.message : String(error),
        data: { goal: options.goal },
      });
      throw error;
    }
  }

  extract<F extends FieldMap>(
    page: PageHandle,
    spec: ExtractSpec<F>,
  ): Promise<ExtractedRecord<F>[]> {
    return page.extractAll(spec);
  }

  private writeArtifact(
    name: string,
    text: string,
    kind: Artifact['kind'],
    mediaType: string,
    options: { dir?: string },
  ): Promise<Artifact> {
    return this.writeArtifactBytes(name, Buffer.from(text, 'utf8'), kind, mediaType, options);
  }

  private async writeArtifactBytes(
    name: string,
    bytes: Buffer,
    kind: Artifact['kind'],
    mediaType: string,
    options: { dir?: string; sourceUrl?: string },
  ): Promise<Artifact> {
    // Named artifacts are addressed by the run, not by a source URL, so the run id
    // is what disambiguates them: two runs of the same job keep both outputs.
    const relativePath = artifactPath({
      jobId: this.job.id,
      canonicalUrl: `snoopit:run/${this.run.id}/${name}`,
      filename: name,
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    });
    const absolutePath = resolve(this.dataDir, relativePath);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);

    const artifact = this.store.artifacts.create({
      jobId: this.job.id,
      runId: this.run.id,
      kind,
      path: relativePath,
      mediaType,
      bytes: bytes.byteLength,
      contentHash: contentHash(bytes),
      ...(options.sourceUrl === undefined ? {} : { sourceUrl: options.sourceUrl }),
    });

    this.store.runs.increment(this.run.id, 'artifactsCreated');
    this.events.emit({
      type: 'ARTIFACT_CREATED',
      message: relativePath,
      data: { bytes: bytes.byteLength, mediaType },
    });
    return artifact;
  }
}
