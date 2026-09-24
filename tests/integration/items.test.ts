/**
 * Following items across runs: new, changed, gone, back — with the history kept.
 *
 * The case this exists for is a saved search on a classifieds site: which ads are
 * new since yesterday, whose price dropped, which disappeared. Each run below is a
 * real run through the runner, so the counters live where a workflow would put them.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend } from '../../src/runtime/browser/fake.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import { workflow, type ItemObservation } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { ItemFields, Job } from '../../src/state/types.js';

let store: Store;
let dataDir: string;
let job: Job;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-items-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'annonces', workflow: 'annonces' });
});

type Listing = Record<string, ItemFields>;

/** One run that observes a whole listing, then sweeps what it did not see. */
async function observeListing(listing: Listing, kind = 'annonce') {
  const outcome = await runWorkflow(
    workflow({
      name: 'annonces',
      run(ctx) {
        const seen: Record<string, ItemObservation['status']> = {};
        for (const [key, fields] of Object.entries(listing)) {
          seen[key] = ctx.items.observe(kind, key, fields).status;
        }
        const gone = ctx.items.markMissing(kind).map((item) => item.key);
        return Promise.resolve({ seen, gone });
      },
    }),
    { store, job, browser: new FakeBackend({ routes: {} }), dataDir, onLine: () => undefined },
  );
  return {
    ...(outcome.result as { seen: Record<string, string>; gone: string[] }),
    runId: outcome.run.id,
  };
}

const velo = { titre: 'Vélo', prix: 250, url: 'https://site.test/ad/1' };
const table = { titre: 'Table', prix: 80, url: 'https://site.test/ad/2' };

describe('ctx.items', () => {
  it('reports everything as new on the first run', async () => {
    const run = await observeListing({ '1': velo, '2': table });
    expect(run).toMatchObject({ seen: { '1': 'new', '2': 'new' }, gone: [] });
  });

  it('reports nothing on an identical second run', async () => {
    await observeListing({ '1': velo, '2': table });
    const run = await observeListing({ '2': table, '1': velo });
    expect(run).toMatchObject({ seen: { '1': 'unchanged', '2': 'unchanged' }, gone: [] });
  });

  it('reports a price drop as a change, with the field-level diff', async () => {
    await observeListing({ '1': velo });
    await observeListing({ '1': { ...velo, prix: 220 } });

    const [event] = store.events.listByType(job.id, 'ITEM_CHANGED');
    expect(event?.data).toMatchObject({ key: '1', diff: { prix: { from: 250, to: 220 } } });
    expect(event?.url).toBe(velo.url);
  });

  it('marks an item gone when a complete run no longer sees it, then back when it returns', async () => {
    await observeListing({ '1': velo, '2': table });

    const second = await observeListing({ '1': velo });
    expect(second.gone).toEqual(['2']);
    expect(store.items.get(job.id, 'annonce', '2')?.status).toBe('gone');

    const third = await observeListing({ '1': velo, '2': { ...table, prix: 60 } });
    expect(third.seen['2']).toBe('returned');
    expect(store.items.get(job.id, 'annonce', '2')?.status).toBe('present');
  });

  it('keeps the whole history of an item', async () => {
    await observeListing({ '1': velo });
    await observeListing({ '1': { ...velo, prix: 220 } });
    await observeListing({});
    await observeListing({ '1': { ...velo, prix: 200 } });

    const item = store.items.get(job.id, 'annonce', '1')!;
    const history = store.items.history(item.id);
    expect(history.map((change) => change.change)).toEqual(['new', 'changed', 'gone', 'returned']);
    expect(history.map((change) => change.diff?.['prix']?.to ?? null)).toEqual([
      null,
      220,
      null,
      200,
    ]);
    expect(item.changeCount).toBe(2);
    expect(item.seenCount).toBe(3);
  });

  it('sweeps one kind without touching another', async () => {
    await observeListing({ '1': velo }, 'annonce:velos');
    await observeListing({ '2': table }, 'annonce:tables');

    expect(store.items.get(job.id, 'annonce:velos', '1')?.status).toBe('present');
    expect(store.items.countByStatus(job.id)).toEqual({ present: 2 });
  });

  it('emits one event per new, changed, gone and returned item', async () => {
    await observeListing({ '1': velo, '2': table });
    await observeListing({ '1': { ...velo, prix: 1 } });
    const last = await observeListing({ '1': { ...velo, prix: 1 }, '2': table });

    expect(store.events.listByType(job.id, 'ITEM_NEW')).toHaveLength(2);
    expect(store.events.listByType(job.id, 'ITEM_CHANGED')).toHaveLength(1);
    expect(store.events.listByType(job.id, 'ITEM_GONE')).toHaveLength(1);
    expect(store.events.listByRun(last.runId).map((event) => event.type)).toContain(
      'ITEM_RETURNED',
    );
  });

  it('refuses an empty key rather than merging unrelated items', async () => {
    const outcome = await runWorkflow(
      workflow({
        name: 'annonces',
        run: (ctx) => Promise.resolve(ctx.items.observe('annonce', ' ', velo)),
      }),
      { store, job, browser: new FakeBackend({ routes: {} }), dataDir, onLine: () => undefined },
    );
    expect(outcome.error?.message).toMatch(/key are required/);
  });
});
