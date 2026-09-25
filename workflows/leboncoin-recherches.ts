/**
 * Workflow `collect` : passer en revue les recherches enregistrées d'un compte
 * leboncoin, et suivre leurs annonces d'un passage à l'autre.
 *
 * Ce que fait un run :
 *
 *  1. charge `/my-searches` (session exigée : une session expirée arrête le run en
 *     `auth-required`) et y relève les recherches enregistrées ;
 *  2. prend quelques recherches dans la frontier — celles jamais vues, puis celles
 *     dont la dernière revue date de plus de 20 h ;
 *  3. pour chacune, **clique** sur la recherche depuis `/my-searches`, comme on le
 *     fait à la main, lit la première page de résultats, puis recharge
 *     `/my-searches` pour la suivante ;
 *  4. enregistre chaque annonce dans `ctx.items` (clé : l'id leboncoin) : nouvelle,
 *     modifiée (prix…), revenue ;
 *  5. quand la page contient toute la liste (compteur « N annonces » ≤ annonces
 *     lues), marque disparues celles qui n'y sont plus.
 *
 * Structure des pages relevée le 2026-09-24 sur le Chrome connecté ; fixtures
 * anonymisées dans `tests/fixtures/leboncoin/`. leboncoin ne pose aucun marqueur
 * stable sur le prix ou la ville : ils sont lus dans les phrases d'accessibilité de
 * chaque carte (« Prix: 339 000 €. », « Située à … »), plus stables que les classes
 * CSS générées.
 *
 * Aucun identifiant ici : la session vit dans le profil Chrome. Face à DataDome, le
 * run s'arrête et le rapporte — rien ne cherche à passer outre.
 */

import type { PageHandle } from '../src/runtime/browser/types.js';
import { RecoveryFailedError } from '../src/runtime/recovery/recover.js';
import {
  workflow,
  type ItemObservation,
  type WorkflowContext,
} from '../src/runtime/workflow/types.js';
import type { FrontierEntry } from '../src/state/types.js';

const ORIGIN = 'https://www.leboncoin.fr';
const MY_SEARCHES = `${ORIGIN}/my-searches`;
/** Une visite connectée finit sur ce domaine ; `auth.leboncoin.fr` = session perdue. */
const SESSION = { expectHost: 'www.leboncoin.fr' } as const;

const SEARCH_CARD = 'article[aria-labelledby^="name-"]';
const SEARCH_LINK = 'a[title="Voir les résultats de recherche"]';
/** Présente sur une page de résultats, y compris vide ; absente de `/my-searches`. */
const RESULTS_READY = 'nav[aria-label="Filtrer les résultats de recherche"]';
const AD_CARD = '[data-qa-id="aditem_container"]';
/**
 * Le navigateur affiche les filtres avant le contenu de la recherche. Attendre ce
 * contenu, et non les filtres, évite de lire une liste encore en cours de rendu.
 * Le compteur est suivi de sa liste, ce qui exclut les autres titres de la page et
 * couvre une recherche qui ne retourne aucune annonce.
 */
const RESULTS_RENDERED = `${AD_CARD}, h2 + ul`;

/** Délai avant qu'une recherche revue revienne en file : une revue par jour environ. */
const REVISIT_AFTER = '20h';
/** Recherches par run quand le planning ne fixe pas `pagesPerRun`. */
const DEFAULT_BATCH = 5;
/**
 * Pause entre deux recherches : une courtoisie de charge, fixe et documentée, pas un
 * déguisement. `SNOOPIT_LBC_PAUSE_MS=0` pour les tests.
 */
const PAUSE_MS = Number(process.env['SNOOPIT_LBC_PAUSE_MS'] ?? 5_000);

/** Kind `ctx.items` d'une annonce : une seule fiche par annonce, toutes recherches confondues. */
const AD_KIND = 'annonce';
/** Kind de la présence d'une annonce dans une recherche, pour détecter ses disparitions. */
const presenceKind = (savedId: string): string => `recherche:${savedId}`;

// ─── Lecture des pages (fonctions pures, testées sur fixtures) ────────────────

export interface SavedSearch {
  readonly savedId: string;
  readonly titre: string;
  readonly criteres: string | null;
  readonly lieux: string | null;
}

/** L'identifiant stable d'une recherche enregistrée, lu dans son lien. */
export function savedSearchId(href: string): string | null {
  const match = /[?&]saved_id_view=([0-9a-f-]{36})(?:&|$)/i.exec(href);
  return match?.[1] ?? null;
}

/**
 * L'URL qui identifie une recherche dans la frontier.
 *
 * Réduite à `saved_id_view` : le lien complet porte aussi `sa` (un horodatage qui
 * bouge) et les critères (que l'on peut modifier), et chacun ferait d'une même
 * recherche une nouvelle entrée. On ne charge jamais cette URL — on clique.
 */
export function searchIdentityUrl(savedId: string): string {
  return `${ORIGIN}/recherche?saved_id_view=${savedId}`;
}

/** « 339 000 € », « 339 000 € » → 339000. */
function integer(text: string | undefined): number | null {
  if (text === undefined) return null;
  const digits = text.replace(/\D/g, '');
  return digits === '' ? null : Number(digits);
}

/** « Résultats de recherche : 13 annonces » → 13. `null` si la page ne le dit pas. */
export function parseResultCount(headings: readonly (string | null)[]): number | null {
  for (const heading of headings) {
    const match = /Résultats de recherche\s*:\s*([\d\s  ]+)\s*annonce/i.exec(heading ?? '');
    if (match !== null) return integer(match[1]);
  }
  return null;
}

/** Ce qu'une carte d'annonce donne à lire, tel qu'extrait du DOM. */
export interface RawAdCard {
  readonly url: string | null;
  readonly libelle: string | null;
  readonly texte: string | null;
  readonly vendeur: string | null;
  readonly mention: string | null;
  readonly photos: string | null;
}

export interface Annonce {
  readonly id: string;
  /**
   * Champs suivis par `ctx.items` : tout changement de l'un d'eux est une
   * modification. N'y mettez rien de relatif au jour (« aujourd'hui à 14:33 ») —
   * chaque annonce paraîtrait modifiée à chaque passage.
   */
  readonly champs: {
    readonly titre: string | null;
    readonly prix: number | null;
    readonly lieu: string | null;
    readonly terrainM2: number | null;
    readonly vendeur: string | null;
    readonly pro: boolean;
    readonly baisseDePrix: boolean;
    readonly photos: number | null;
    readonly url: string;
  };
  /** Date de publication telle qu'affichée (« mardi dernier à 12:22 »), pros seulement. */
  readonly publication: string | null;
}

/** Lit une carte d'annonce. `null` pour ce qui n'en est pas une (encart, carte vide). */
export function parseAdCard(card: RawAdCard): Annonce | null {
  const link = /\/ad\/([^/?#]+)\/(\d+)/.exec(card.url ?? '');
  if (link === null) return null;
  const [, category, id] = link as unknown as [string, string, string];
  const texte = card.texte ?? '';

  const titre = card.libelle?.replace(/^Voir l[’']annonce\s*:\s*/, '').trim() || null;
  const lieu = /Située à (.+?)\.(?:\s|$)/.exec(texte)?.[1]?.trim() ?? null;

  return {
    id,
    champs: {
      titre,
      prix: integer(/Prix\s*:\s*([\d\s  ]+)\s*€/.exec(texte)?.[1]),
      lieu,
      terrainM2: integer(/Surface du terrain ([\d\s  ]+) mètres carrés/.exec(texte)?.[1]),
      vendeur: card.vendeur?.trim() || null,
      pro: card.vendeur !== null || /Vendeur professionnel/.test(texte),
      baisseDePrix: /Baisse de prix/.test(texte),
      photos: integer(/sur (\d+)/.exec(card.photos ?? '')?.[1]),
      url: `${ORIGIN}/ad/${category}/${id}`,
    },
    publication: /publiée (.+?), voir/.exec(card.mention ?? '')?.[1] ?? null,
  };
}

/** Nombre de champs renseignés : la carte complète l'emporte sur la carte réduite. */
function richness(ad: Annonce): number {
  return Object.values(ad.champs).filter((value) => value !== null && value !== false).length;
}

/**
 * Une annonce par id, en fusionnant ses apparitions.
 *
 * Une annonce « remontée » apparaît deux fois sur la page : en tête, sous une forme
 * réduite (sans photos ni vendeur, titre rédigé autrement), puis à son rang,
 * complète. On part de l'apparition la plus complète et on ne comble que ses
 * trous : sinon le titre dépendrait de ce que l'annonce soit remontée ou non ce
 * jour-là, et elle paraîtrait modifiée d'un passage à l'autre.
 */
export function mergeAds(ads: readonly Annonce[]): Annonce[] {
  const groups = new Map<string, Annonce[]>();
  for (const ad of ads) groups.set(ad.id, [...(groups.get(ad.id) ?? []), ad]);

  return [...groups.values()].map((group) => {
    const [base, ...others] = [...group].sort((a, b) => richness(b) - richness(a)) as [
      Annonce,
      ...Annonce[],
    ];
    const champs = { ...base.champs } as Record<string, unknown>;
    for (const other of others) {
      for (const [name, value] of Object.entries(other.champs)) {
        if (champs[name] === null) champs[name] = value;
      }
    }
    return {
      id: base.id,
      champs: champs as Annonce['champs'],
      publication:
        base.publication ?? others.find((o) => o.publication !== null)?.publication ?? null,
    };
  });
}

// ─── Le run ───────────────────────────────────────────────────────────────────

interface AnnonceVue {
  readonly id: string;
  readonly titre: string | null;
  readonly prix: number | null;
  readonly lieu: string | null;
  readonly url: string;
  readonly publication?: string | null;
  readonly changements?: ItemObservation['diff'];
}

interface BilanRecherche {
  readonly savedId: string;
  readonly titre: string;
  readonly criteres: string | null;
  readonly total: number | null;
  readonly lues: number;
  /** La page contenait toute la liste : les disparitions sont fiables. */
  readonly complete: boolean;
  readonly nouvelles: AnnonceVue[];
  readonly modifiees: AnnonceVue[];
  readonly disparues: AnnonceVue[];
  readonly erreur?: string;
}

/** Une recherche illisible : on la note en échec et on passe à la suivante. */
class ReviewError extends Error {}

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

async function openMySearches(ctx: WorkflowContext, record: boolean): Promise<PageHandle> {
  const { page } = await ctx.visit(MY_SEARCHES, {
    waitFor: SEARCH_CARD,
    session: SESSION,
    record,
  });
  await ctx.dismissOverlays(page);
  return page;
}

async function readSavedSearches(ctx: WorkflowContext, page: PageHandle): Promise<SavedSearch[]> {
  const rows = await ctx.extract(page, {
    selector: SEARCH_CARD,
    fields: {
      url: `${SEARCH_LINK}@href`,
      titre: 'p[id^="name-"]',
      criteres: 'p:not([id]):not([aria-label])',
      lieux: 'p[aria-label]@aria-label',
    },
  });
  const searches: SavedSearch[] = [];
  for (const row of rows) {
    const savedId = savedSearchId(row.url ?? '');
    if (savedId === null) continue;
    searches.push({
      savedId,
      titre: row.titre ?? savedId,
      criteres: row.criteres,
      lieux: row.lieux,
    });
  }
  return searches;
}

/** Depuis `/my-searches` : clique sur la recherche et attend ses résultats. */
async function openResults(
  ctx: WorkflowContext,
  page: PageHandle,
  search: SavedSearch,
): Promise<void> {
  await page.click(`${SEARCH_LINK}[href*="saved_id_view=${search.savedId}"]`);
  try {
    await page.waitForReady({ selector: RESULTS_READY });
  } catch {
    // La page attendue n'est pas là. Si c'est un challenge, recover le reconnaît et
    // arrête le run (BlockedError) ; sinon, un bandeau fermé suffit peut-être.
    try {
      await ctx.recover(page, {
        goal: `Afficher les résultats de la recherche « ${search.titre} »`,
        expectedState: { selector: RESULTS_READY },
        allowedActions: ['close_overlay'],
      });
    } catch (error) {
      if (error instanceof RecoveryFailedError) {
        throw new ReviewError('page de résultats introuvable après le clic');
      }
      throw error;
    }
  }
  if (savedSearchId(page.url()) !== search.savedId) {
    throw new ReviewError(`le clic a mené à ${page.url()}, pas à la recherche attendue`);
  }
  // Les filtres arrivent avant les résultats. On attend donc une carte ou le
  // compteur, jusqu'au timeout navigateur normal. Une liste vide possède le
  // compteur et ne paie pas ce délai.
  try {
    await page.waitForReady({ selector: RESULTS_RENDERED });
  } catch {
    throw new ReviewError('résultats non rendus après le clic');
  }
}

async function reviewSearch(
  ctx: WorkflowContext,
  page: PageHandle,
  search: SavedSearch,
): Promise<BilanRecherche> {
  await openResults(ctx, page, search);

  const headings = await ctx.extract(page, { selector: 'h2', fields: { texte: '@text' } });
  const total = parseResultCount(headings.map((heading) => heading.texte));
  const cards = await ctx.extract(page, {
    selector: AD_CARD,
    fields: {
      url: 'a[href^="/ad/"]@href',
      libelle: 'a[href^="/ad/"] > span[title]@title',
      texte: '@text',
      vendeur: '[data-qa-id="pro-store-name"]',
      mention: 'a[href^="/boutique/"]@aria-label',
      photos: 'button[aria-label^="Passer à la photo"]@aria-label',
    },
  });
  const annonces = mergeAds(cards.map(parseAdCard).filter((ad): ad is Annonce => ad !== null));

  if (total === null && annonces.length === 0) {
    throw new ReviewError('ni compteur ni annonce : la page a-t-elle changé ?');
  }

  const nouvelles: AnnonceVue[] = [];
  const modifiees: AnnonceVue[] = [];
  for (const annonce of annonces) {
    const { status, diff } = ctx.items.observe(AD_KIND, annonce.id, annonce.champs);
    ctx.items.observe(presenceKind(search.savedId), annonce.id, {});
    const vue: AnnonceVue = {
      id: annonce.id,
      titre: annonce.champs.titre,
      prix: annonce.champs.prix,
      lieu: annonce.champs.lieu,
      url: annonce.champs.url,
      publication: annonce.publication,
    };
    if (status === 'new') nouvelles.push(vue);
    else if (status === 'changed' || status === 'returned') {
      modifiees.push({ ...vue, changements: diff });
    }
  }

  // Seulement quand la page montre toute la liste : sinon une annonce sortie de la
  // première page serait déclarée disparue à tort.
  const complete = total !== null && total <= annonces.length;
  const disparues = complete
    ? ctx.items.markMissing(presenceKind(search.savedId)).map((gone): AnnonceVue => {
        const fiche = ctx.items.get(AD_KIND, gone.key)?.fields ?? {};
        return {
          id: gone.key,
          titre: typeof fiche['titre'] === 'string' ? fiche['titre'] : null,
          prix: typeof fiche['prix'] === 'number' ? fiche['prix'] : null,
          lieu: typeof fiche['lieu'] === 'string' ? fiche['lieu'] : null,
          url: typeof fiche['url'] === 'string' ? fiche['url'] : `${ORIGIN}/ad/${gone.key}`,
        };
      })
    : [];

  return {
    savedId: search.savedId,
    titre: search.titre,
    criteres: search.criteres,
    total,
    lues: annonces.length,
    complete,
    nouvelles,
    modifiees,
    disparues,
  };
}

function euros(prix: number | null): string {
  return prix === null ? 'prix ?' : `${prix.toLocaleString('fr-FR')} €`;
}

function markdown(bilans: readonly BilanRecherche[], listees: number): string {
  const lines = [
    '# Recherches enregistrées leboncoin',
    '',
    `${String(bilans.length)} recherche(s) revue(s) ce passage, sur ${String(listees)} enregistrée(s).`,
    '',
  ];
  for (const bilan of bilans) {
    lines.push(`## ${bilan.titre}`, '');
    if (bilan.criteres !== null) lines.push(`_${bilan.criteres}_`, '');
    if (bilan.erreur !== undefined) {
      lines.push(`**Non revue** : ${bilan.erreur}`, '');
      continue;
    }
    lines.push(
      `${String(bilan.lues)} annonce(s) lue(s)` +
        (bilan.total === null ? '' : ` sur ${String(bilan.total)}`) +
        (bilan.complete ? ' — liste complète.' : ' — première page seulement.'),
      '',
    );
    for (const ad of bilan.nouvelles) {
      lines.push(`- 🆕 [${ad.titre ?? ad.id}](${ad.url}) — ${euros(ad.prix)} — ${ad.lieu ?? ''}`);
    }
    for (const ad of bilan.modifiees) {
      const prix = ad.changements?.['prix'];
      const detail =
        prix === undefined
          ? Object.keys(ad.changements ?? {}).join(', ')
          : `prix ${euros(prix.from as number | null)} → ${euros(prix.to as number | null)}`;
      lines.push(`- ✏️ [${ad.titre ?? ad.id}](${ad.url}) — ${detail}`);
    }
    for (const ad of bilan.disparues) {
      lines.push(`- ❌ [${ad.titre ?? ad.id}](${ad.url}) — ${euros(ad.prix)} — n'apparaît plus`);
    }
    if (bilan.nouvelles.length + bilan.modifiees.length + bilan.disparues.length === 0) {
      lines.push('Rien de nouveau.');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export default workflow({
  name: 'leboncoin-recherches',
  type: 'collect',
  description: 'Passe en revue les recherches enregistrées leboncoin et suit leurs annonces',
  // Une visite de /my-searches par recherche revue, plus la première. Les clics ne
  // comptent pas dans maxPages : c'est le lot (pagesPerRun, sinon 5) qui les borne.
  budget: { maxPages: 12, maxDuration: '10m', maxErrors: 3 },

  async run(ctx) {
    ctx.frontier.enqueueDueRevisits();

    let page = await openMySearches(ctx, true);
    const bilans: BilanRecherche[] = [];
    let listees = 0;

    try {
      const searches = await readSavedSearches(ctx, page);
      listees = searches.length;
      const current = new Map(searches.map((search) => [search.savedId, search]));
      for (const search of searches) {
        ctx.frontier.discover(searchIdentityUrl(search.savedId), {
          meta: { savedId: search.savedId, titre: search.titre },
        });
      }

      let first = true;
      for (const entry of ctx.frontier.take(DEFAULT_BATCH)) {
        const savedId = savedSearchId(entry.url);
        const search = savedId === null ? undefined : current.get(savedId);
        if (search === undefined) {
          // Supprimée du compte : plus rien à revoir, et pas de revisite.
          ctx.frontier.fail(entry, 'recherche absente de /my-searches');
          continue;
        }

        if (!first) {
          await page.close();
          await sleep(PAUSE_MS);
          page = await openMySearches(ctx, false);
        }
        first = false;

        bilans.push(await reviewOne(ctx, page, entry, search));
      }
    } finally {
      await page.close();
    }

    await ctx.artifacts.writeJson('recherches.json', { listees, bilans });
    await ctx.artifacts.writeMarkdown('recherches.md', markdown(bilans, listees));

    const count = (pick: (bilan: BilanRecherche) => number): number =>
      bilans.reduce((sum, bilan) => sum + pick(bilan), 0);
    return {
      recherches: listees,
      verifiees: bilans.filter((bilan) => bilan.erreur === undefined).length,
      nouvelles: count((bilan) => bilan.nouvelles.length),
      modifiees: count((bilan) => bilan.modifiees.length),
      disparues: count((bilan) => bilan.disparues.length),
      echecs: bilans.filter((bilan) => bilan.erreur !== undefined).length,
    };
  },
});

async function reviewOne(
  ctx: WorkflowContext,
  page: PageHandle,
  entry: FrontierEntry,
  search: SavedSearch,
): Promise<BilanRecherche> {
  try {
    const bilan = await reviewSearch(ctx, page, search);
    ctx.frontier.complete(entry, { revisitAfter: REVISIT_AFTER });
    return bilan;
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    ctx.frontier.fail(entry, error.message, { revisitAfter: REVISIT_AFTER });
    return {
      savedId: search.savedId,
      titre: search.titre,
      criteres: search.criteres,
      total: null,
      lues: 0,
      complete: false,
      nouvelles: [],
      modifiees: [],
      disparues: [],
      erreur: error.message,
    };
  }
}
