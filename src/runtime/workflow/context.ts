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
import { canonicalizeUrl } from '../navigation/canonical.js';
import { downloadTo } from '../downloads/download.js';
import { artifactPath } from '../downloads/paths.js';
import type { RunEventEmitter } from '../events/emitter.js';
import type { BudgetGuard } from '../budget/guard.js';
import type { Store } from '../../state/store.js';
import type { Artifact, FrontierEntry, Job, Run } from '../../state/types.js';
import { contentHash } from '../../util/hash.js';
import { isoFromNow, parseDuration } from '../../util/time.js';
import { enqueueDueRevisits } from '../../scheduler/revisit.js';
import { dismissOverlays, type DismissResult } from '../recovery/heuristics.js';
import { recover, type RecoverOptions, type RecoveryOutcome } from '../recovery/recover.js';
import type { LlmProvider } from '../recovery/llm/provider.js';
import type {
  CollectOptions,
  CollectResult,
  DiscoverOptions,
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

    if (options.waitFor !== undefined) {
      await page.waitForReady({
        selector: options.waitFor,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    }

    if (options.record === false) {
      return { page, navigation, record: null, changed: false, firstVisit: false };
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

      return { page, navigation, record, changed: false, firstVisit: false };
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
    };
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
      const download = await downloadTo(page, url, {
        jobId: this.job.id,
        dataDir: this.dataDir,
        ...(options.dir === undefined ? {} : { dir: options.dir }),
        ...(options.filename === undefined ? {} : { filename: options.filename }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });

      // Content-addressed deduplication: the same bytes republished at a second URL
      // are not a second artifact, and re-recording them would inflate the report.
      if (options.dedupe !== false) {
        const existing = this.store.artifacts
          .findByHash(this.job.id, download.contentHash)
          .find((candidate) => candidate.path === download.path);
        if (existing !== undefined) {
          return { artifact: existing, deduplicated: true };
        }
      }

      const pageRow = this.store.pages.get(this.job.id, canonicalUrl);
      const artifact = this.store.artifacts.create({
        jobId: this.job.id,
        runId: this.run.id,
        pageId: pageRow?.id ?? null,
        sourceUrl: download.url,
        canonicalUrl,
        kind: download.mediaType === 'application/pdf' ? 'pdf' : 'file',
        path: download.path,
        mediaType: download.mediaType,
        bytes: download.bytes,
        contentHash: download.contentHash,
      });

      this.store.runs.increment(this.run.id, 'artifactsCreated');
      this.store.runs.increment(this.run.id, 'downloadedBytes', download.bytes);
      // Bytes are counted after the fact: the size is only known once the body has
      // arrived, so this limit guards disk and the next iteration, not this transfer.
      this.budget.recordBytes(download.bytes);
      this.budget.recordPage();
      this.events.emit({
        type: 'ARTIFACT_CREATED',
        url: download.url,
        canonicalUrl,
        message: download.path,
        data: { bytes: download.bytes, mediaType: download.mediaType },
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
