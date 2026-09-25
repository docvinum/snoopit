/**
 * Le workflow leboncoin, de bout en bout, sans navigateur ni réseau.
 *
 * Les pages sont les fixtures anonymisées de `tests/fixtures/leboncoin/`, relevées
 * sur le Chrome connecté : `/my-searches`, deux pages de résultats (une liste
 * complète, une tronquée) et l'interstitiel DataDome réellement servi. Le
 * `FakeBackend` suit les liens au clic, ce qui reproduit le parcours du workflow.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeResponse } from '../../src/runtime/browser/fake.js';
import { canonicalizeUrlOrThrow } from '../../src/runtime/navigation/canonical.js';
import { runWorkflow } from '../../src/runtime/workflow/runner.js';
import type { WorkflowDefinition } from '../../src/runtime/workflow/types.js';
import { Store } from '../../src/state/store.js';
import type { Job } from '../../src/state/types.js';
import { isoFromNow } from '../../src/util/time.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/leboncoin');
const MY_SEARCHES = 'https://www.leboncoin.fr/my-searches';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const html = (body: string, status = 200): FakeResponse => ({
  status,
  body,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});

/** Le lien d'une recherche tel que `/my-searches` le porte, résolu en URL absolue. */
function resultsUrl(page: string, savedId: string): string {
  const href = new RegExp(`href="(/recherche\\?[^"]*saved_id_view=${savedId})"`).exec(page)?.[1];
  if (href === undefined) throw new Error(`no link for ${savedId}`);
  return new URL(href.replaceAll('&amp;', '&'), MY_SEARCHES).href;
}

let definition: WorkflowDefinition;
let store: Store;
let dataDir: string;
let job: Job;
let routes: Record<string, FakeResponse>;

function serve(url: string, response: FakeResponse): void {
  routes[canonicalizeUrlOrThrow(url)] = response;
}

/** Le site tel que les fixtures le décrivent, modifiable test par test. */
function site(options: { mySearches?: string; a?: string; b?: FakeResponse } = {}): void {
  const mySearches = options.mySearches ?? read('my-searches.html');
  routes = {};
  serve(MY_SEARCHES, html(mySearches));
  serve(resultsUrl(read('my-searches.html'), A), html(options.a ?? read('resultats-a.html')));
  serve(resultsUrl(read('my-searches.html'), B), options.b ?? html(read('resultats-b.html')));
}

beforeAll(async () => {
  process.env['SNOOPIT_LBC_PAUSE_MS'] = '0';
  definition = (await import('../../workflows/leboncoin-recherches.js')).default;
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'snoopit-lbc-'));
  store = Store.open({ path: join(dataDir, 'snoopit.db') });
  job = store.jobs.upsert({ name: 'leboncoin-recherches', workflow: 'leboncoin-recherches' });
  site();
});

async function run() {
  return runWorkflow(definition, {
    store,
    job,
    browser: new FakeBackend({ routes }),
    dataDir,
    onLine: () => undefined,
  });
}

/** Fait comme si la dernière revue de chaque recherche datait d'hier. */
function makeSearchesDue(): void {
  for (const id of [A, B]) {
    store.pages.scheduleRevisit(
      job.id,
      canonicalizeUrlOrThrow(`https://www.leboncoin.fr/recherche?saved_id_view=${id}`),
      isoFromNow(-60_000),
    );
  }
}

describe('leboncoin-recherches — premier passage', () => {
  it('revoit chaque recherche et enregistre chaque annonce une seule fois', async () => {
    const outcome = await run();

    expect(outcome.run.stopReason).toBe('done');
    // 4 annonces distinctes dans A (dont une « remontée » en double), 2 dans B dont
    // une déjà vue dans A : 5 nouvelles, pas 7.
    expect(outcome.result).toEqual({
      recherches: 2,
      verifiees: 2,
      nouvelles: 5,
      modifiees: 0,
      disparues: 0,
      echecs: 0,
    });
    expect(store.items.list(job.id, { kind: 'annonce' })).toHaveLength(5);
  });

  it("fusionne les deux apparitions d'une annonce remontée sans la dire modifiée", async () => {
    const outcome = await run();

    expect(store.events.listByType(job.id, 'ITEM_CHANGED')).toHaveLength(0);
    expect(store.items.get(job.id, 'annonce', '1002')?.fields).toMatchObject({
      titre: 'Maison · 6 pièces · 131m²',
      prix: 285000,
      photos: 3,
      vendeur: 'Agence Test',
      pro: true,
    });
    expect(outcome.run.counters.errorCount).toBe(0);
  });

  it('lit prix, lieu, terrain et baisse de prix dans les phrases de la carte', async () => {
    await run();
    expect(store.items.get(job.id, 'annonce', '1003')?.fields).toEqual({
      titre: 'Terrain',
      prix: 116000,
      lieu: 'Autre-Ville 77001',
      terrainM2: 9659,
      vendeur: 'Cabinet Fictif',
      pro: true,
      baisseDePrix: true,
      photos: 2,
      url: 'https://www.leboncoin.fr/ad/ventes_immobilieres/1003',
    });
  });

  it('écrit un rapport lisible et un JSON par recherche', async () => {
    const outcome = await run();
    const artifacts = store.artifacts.listByRun(outcome.run.id);
    const md = artifacts.find((artifact) => artifact.path.endsWith('.md'));
    const text = readFileSync(resolve(dataDir, md!.path), 'utf8');

    expect(text).toContain('## Recherche test A');
    expect(text).toContain('liste complète');
    expect(text).toContain('première page seulement');
    expect(text).toContain(
      '🆕 [Maison · 5 pièces · 133m²](https://www.leboncoin.fr/ad/ventes_immobilieres/1001)',
    );
  });

  it('clique depuis /my-searches au lieu de charger les résultats directement', async () => {
    const browser = new FakeBackend({ routes });
    await runWorkflow(definition, { store, job, browser, dataDir, onLine: () => undefined });

    const navigations = browser.journal.filter((entry) => entry.action === 'navigate');
    const clicks = browser.journal.filter((entry) => entry.action === 'click');
    expect(clicks.map((entry) => entry.target)).toEqual([
      expect.stringContaining(`saved_id_view=${A}`),
      expect.stringContaining(`saved_id_view=${B}`),
    ]);
    // Seul /my-searches est chargé ; les résultats ne le sont que par un clic.
    expect(
      navigations.filter((entry) => !entry.target.includes('/my-searches')).map((e) => e.target),
    ).toEqual([
      expect.stringContaining(`saved_id_view=${A}`),
      expect.stringContaining(`saved_id_view=${B}`),
    ]);
    // La barre de filtres apparaît avant les résultats : attendre seulement cette
    // barre ferait extraire une page encore vide sur le vrai site. La liste qui
    // suit le compteur (y compris vide) ou une carte confirme que le résultat est
    // rendu, sans être trompée par les autres titres de la page.
    expect(
      browser.journal.filter((entry) => entry.action === 'wait').map((entry) => entry.target),
    ).toContain('[data-qa-id="aditem_container"], h2 + ul');
  });
});

describe('leboncoin-recherches — passages suivants', () => {
  it("ne revoit pas une recherche avant l'échéance de sa revisite", async () => {
    await run();
    const second = await run();
    expect(second.result).toMatchObject({ recherches: 2, verifiees: 0, nouvelles: 0 });
  });

  it('signale une baisse de prix et une annonce disparue d’une liste complète', async () => {
    await run();
    makeSearchesDue();
    site({
      a: read('resultats-a.html')
        .replace('Résultats de recherche : 4 annonces', 'Résultats de recherche : 3 annonces')
        .replaceAll('239 000', '225 000')
        .replace(
          /<li>\s*<article aria-label="Maison, 4 pièces, 95 mètres carrés\.">[\s\S]*?<\/li>/,
          '',
        ),
      // La même annonce figure dans B : son prix y baisse aussi. Elle n'est
      // modifiée qu'une fois — la seconde observation la trouve déjà à jour.
      b: html(read('resultats-b.html').replaceAll('239\u202f000', '225\u202f000')),
    });

    const outcome = await run();

    expect(outcome.result).toMatchObject({
      verifiees: 2,
      nouvelles: 0,
      modifiees: 1,
      disparues: 1,
    });
    const [changed] = store.events.listByType(job.id, 'ITEM_CHANGED');
    expect(changed?.data).toMatchObject({
      key: '1001',
      diff: { prix: { from: 239000, to: 225000 } },
    });
    // Disparue de la recherche A, dont la liste était complète…
    expect(store.items.get(job.id, `recherche:${A}`, '1004')?.status).toBe('gone');
  });

  it('ne conclut à aucune disparition sur une liste tronquée', async () => {
    await run();
    makeSearchesDue();
    site({
      b: html(
        read('resultats-b.html').replace(
          /<li>\s*<article aria-label="Maison, 3 pièces[\s\S]*?<\/li>/,
          '',
        ),
      ),
    });

    const outcome = await run();

    // 2001 n'est plus en première page de B, mais B compte 42 annonces : rien à conclure.
    expect(outcome.result).toMatchObject({ disparues: 0 });
    expect(store.items.get(job.id, `recherche:${B}`, '2001')?.status).toBe('present');
  });

  it('met en échec, sans revisite, une recherche supprimée du compte', async () => {
    await run();
    makeSearchesDue();
    site({
      mySearches: read('my-searches.html').replace(
        new RegExp(`<li>\\s*<article aria-labelledby="name-${B}">[\\s\\S]*?</li>`),
        '',
      ),
    });

    const outcome = await run();

    expect(outcome.result).toMatchObject({ recherches: 1, verifiees: 1 });
    const entry = store.frontier.get(
      job.id,
      canonicalizeUrlOrThrow(`https://www.leboncoin.fr/recherche?saved_id_view=${B}`),
    );
    expect(entry?.state).toBe('failed');
    expect(entry?.lastError).toBe('recherche absente de /my-searches');
  });
});

describe("leboncoin-recherches — quand il faut s'arrêter", () => {
  it('s’arrête en auth-required quand la session a expiré', async () => {
    serve(MY_SEARCHES, {
      redirectTo: 'https://auth.leboncoin.fr/login/?from_to=https://www.leboncoin.fr/my-searches',
    });
    serve(
      'https://auth.leboncoin.fr/login/?from_to=https://www.leboncoin.fr/my-searches',
      html('<h1>Connectez-vous ou créez votre compte leboncoin</h1>'),
    );

    const outcome = await run();

    expect(outcome.run.stopReason).toBe('auth-required');
    expect(store.items.list(job.id)).toHaveLength(0);
  });

  it("s'arrête sur l'interstitiel DataDome après un clic, sans rien perdre de ce qui précède", async () => {
    site({ b: html(read('datadome.html'), 403) });

    const outcome = await run();

    expect(outcome.run.stopReason).toBe('blocked:captcha');
    // A a été revue avant le blocage ; B retourne en file pour un prochain run.
    expect(store.items.list(job.id, { kind: 'annonce' })).toHaveLength(4);
    const b = store.frontier.get(
      job.id,
      canonicalizeUrlOrThrow(`https://www.leboncoin.fr/recherche?saved_id_view=${B}`),
    );
    expect(b?.state).toBe('queued');
  });

  it("reconnaît l'interstitiel DataDome à son script, même servi en 200", async () => {
    serve(MY_SEARCHES, html(read('datadome.html')));
    const outcome = await run();
    expect(outcome.run.stopReason).toBe('blocked:captcha');
  });
});
