---
name: snoopit
description: Écrire un workflow snoopit — visiter un site régulièrement, mémoriser ce qui a été vu, détecter les changements, collecter des documents avec leur provenance. Utiliser quand on demande de surveiller un site, récupérer des PDF ou fichiers publiés, suivre des annonces, auditer des liens, ou alimenter un RAG depuis le web.
---

# Écrire un workflow snoopit

`snoopit` visite des sites dans un vrai Chrome, se souvient de ce qu'il a vu, et
reprend après interruption. **Votre travail : un fichier dans `workflows/`. Jamais
une modification du runtime.**

---

## 1. Le squelette

```ts
// workflows/mon-workflow.ts
import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'mon-workflow',
  type: 'collect',                 // 'collect' | 'audit'
  description: 'Une phrase.',
  budget: { maxPages: 50, maxDuration: '20m', maxLlmCalls: 0 },

  async run(ctx) {
    // ...
    return { /* résumé, repris tel quel dans report.json */ };
  },
});
```

L'extension `.js` dans l'import est obligatoire, même si le fichier est `.ts`.

Puis : `npm run build && node dist/src/cli/main.js run mon-workflow`

---

## 2. Le patron à recopier

Découverte puis collecte, en deux phases. **C'est ce qui rend la reprise possible** :
un run tué reprend en consommant ce qui reste dans la frontier.

```ts
async run(ctx) {
  const startUrl = 'https://example.com/publications';

  // ── Phase 1 : découverte ────────────────────────────────────────────────
  const { page } = await ctx.visit(startUrl, { waitFor: '.publication-list' });
  await ctx.dismissOverlays(page);          // bannière cookies, modale — sans LLM

  const items = await ctx.extract(page, {
    selector: '.publication',
    fields: { title: '.title', date: '.date', pdf: '.download@href' },
  });

  for (const item of items) {
    if (item.pdf === null) continue;
    ctx.frontier.discover(item.pdf, {
      kind: 'document',
      meta: { title: item.title, date: item.date },
    });
  }
  await page.close();

  // ── Phase 2 : collecte ──────────────────────────────────────────────────
  const collector = await ctx.browser.open(startUrl);
  let collected = 0;
  try {
    for (const entry of ctx.frontier.take(50)) {
      try {
        const { deduplicated } = await ctx.artifacts.collect(collector, entry.url, {
          dir: 'publications',
        });
        if (!deduplicated) collected += 1;
        ctx.frontier.complete(entry);
      } catch (error) {
        // Un document illisible n'arrête pas la collecte.
        ctx.frontier.fail(entry, String(error));
      }
    }
  } finally {
    await collector.close();
  }

  return { seen: items.length, collected, remaining: ctx.frontier.remaining() };
}
```

Exemples complets et testés : [`workflows/`](../../workflows/) —
`example-publications.ts` (collecte), `example-audit.ts` (audit),
`example-catalogue.ts` (visite partielle), `example-gated.ts` (recovery).

---

## 3. Les primitives

### Visiter

```ts
const { page, navigation, changed, firstVisit } = await ctx.visit(url, {
  waitFor: '.liste',        // attente déterministe d'un sélecteur
  revisitAfter: '7d',       // quand cette page méritera un nouveau regard
});
await page.close();          // TOUJOURS, y compris en erreur (finally)
```

`navigation` porte `status`, `redirectChain`, `ok`.
`changed` est vrai si le contenu diffère de la visite précédente — **c'est le signal
de veille**. `offSite` est vrai si la navigation a fini sur un autre site : la page
est alors enregistrée en erreur, pas comme visitée.

Un 403, un 429 ou un widget de challenge (DataDome compris) **arrête le run dès
`visit`** (`blocked:<raison>`) — rien à écrire de votre côté.

Page réservée aux connectés ? Déclarez-le, et une session expirée arrête le run en
`auth-required` au lieu d'enregistrer la page de connexion :

```ts
await ctx.visit('https://www.leboncoin.fr/my-searches', {
  session: { expectHost: 'www.leboncoin.fr' },   // + loginSelector si le mur est rendu sur place
});
```

### Découvrir

```ts
ctx.frontier.discover(url, { kind: 'document', priority: 50, meta: { … } });
ctx.frontier.discoverAll(urls);
```

Idempotent : redécouvrir une URL déjà traitée ne la remet pas en file. **Reparcourez
l'index à chaque run, c'est correct et attendu.**

### Collecter

```ts
const { artifact, deduplicated } = await ctx.artifacts.collect(page, url, {
  dir: 'publications',
});
ctx.frontier.complete(entry);      // ou ctx.frontier.fail(entry, message)
```

Télécharge via la session de la page (mêmes cookies), hash le contenu, enregistre la
provenance. `deduplicated` est vrai si le job détenait déjà ces octets exacts, à cette
URL ou à une autre : rien n'est écrit. Un contenu modifié à la même URL est écrit à
côté de l'ancien, jamais par-dessus.

### Suivre des éléments (annonces, produits…)

```ts
const { status, diff } = ctx.items.observe('annonce:velos', ad.id, {
  titre: ad.titre,
  prix: ad.prix,            // nombre, pas « 250 € »
  url: ad.url,
});
// status : 'new' | 'changed' | 'returned' | 'unchanged'  ;  diff : { prix: { from, to } }
ctx.items.markMissing('annonce:velos');   // SEULEMENT si toute la liste a été lue
```

Identité : la clé du site (id d'annonce), pas l'URL. État et historique en SQLite —
**ne comparez jamais avec le JSON du run précédent**. `ctx.items.history(kind, key)`
donne l'historique (prix compris).

### Extraire

```ts
const rows = await ctx.extract(page, {
  selector: '.item',
  fields: { titre: '.title', lien: 'a@href', id: '@data-id', corps: '.body@html' },
});
```

Chaque champ est `[sélecteur][@attribut]`, relatif à l'item :

| Spec | Sens |
|---|---|
| `.title` | texte du premier `.title` descendant |
| `a@href` | attribut `href`, **résolu en URL absolue** |
| `@data-id` | attribut de l'item lui-même |
| `@text` | texte de l'item lui-même |
| `.body@html` | HTML interne |

Les noms de champs sont **typés** : `rows[0].titre` existe, `rows[0].titer` ne
compile pas. Un champ absent vaut `null`, jamais une exception.

### Produire

```ts
await ctx.artifacts.writeJson('resultats.json', data);
await ctx.artifacts.writeMarkdown('resume.md', texte);
await ctx.artifacts.screenshot(page, 'accueil.png');
```

### Récupérer

```ts
await ctx.recover(page, {
  goal: 'Accéder à la liste des publications',
  expectedState: { selector: '.publication-list' },
  allowedActions: ['click', 'scroll', 'close_overlay'],
  maxSteps: 4,
});
```

Un **garde**, pas une étape : rend la main immédiatement si l'état est déjà là.
Escalade L1 (heuristiques, sans LLM) → L2 (LLM/DOM) → L3 (LLM/screenshot) → L4
(échec explicite). Sans clé API, s'arrête à L1 — ce qui suffit dans l'immense
majorité des cas.

Pour une simple bannière, `ctx.dismissOverlays(page)` suffit.

### Revisiter

```ts
const requeued = ctx.frontier.enqueueDueRevisits();   // AU DÉBUT du run
const { page } = await ctx.visit(url, { revisitAfter: '7d' });
```

Au début : une visite rafraîchit `next_visit_after`, donc vérifier après ne
trouverait jamais rien.

> **Piège classique.** `ctx.frontier.take()` ne rend que ce qui est *en file*. Une
> entrée déjà `complete()` n'y revient qu'à son échéance de revisite. Un workflow de
> veille peut donc parfaitement ne rien vérifier lors d'un run — et s'il ne compte
> que les pages *modifiées*, il rapportera « rien n'a bougé » sans avoir rien
> regardé. **Comptez toujours les pages réellement visitées**, séparément :
>
> ```ts
> return { verifiees, modifiees: modifiees.length };  // pas seulement modifiees
> ```

---

## 4. Les règles

1. **Deux phases.** Découverte puis collecte. C'est ce qui permet reprise,
   priorisation et déduplication.
2. **Fermez vos pages.** `await page.close()`, dans un `finally`.
3. **`maxLlmCalls: 0` quand c'est vrai.** Cela documente l'intention *et* la fait
   respecter.
4. **Ne forcez jamais un clic.** `click()` refuse un élément invisible, `inert`,
   `aria-hidden` ou désactivé. Le refus signale presque toujours que le workflow a
   dérivé, pas que le garde-fou a tort.
5. **Une ressource illisible n'arrête pas la collecte.** `ctx.frontier.fail()` et on
   continue ; le problème apparaît au rapport.
6. **Face à un blocage, on s'arrête.** CAPTCHA, 403, limitation : le runtime le
   détecte et arrête proprement. **N'écrivez aucun contournement** — ni rotation
   d'identité, ni résolution de challenge, ni dissimulation. Ce sera refusé en revue.
7. **Ne dépendez pas d'un numéro de page.** L'identité est l'URL canonique.
8. **Ne vous connectez pas depuis une heuristique.** Le recovery ne clique jamais
   « Se connecter ». La session vit dans le profil Chrome, posée par une personne ;
   déclarez-la avec `visit(url, { session })` pour qu'une expiration arrête le run
   en `auth-required`. Un workflow ne contient jamais d'identifiant.

---

## 5. Budgets et planification

```ts
budget: { maxPages: 50, maxDuration: '20m', maxDownloadBytes: 500_000_000, maxLlmCalls: 0 }
```

`maxPages` compte les **unités de travail** : une visite et un document collecté
valent chacun 1.

Atteindre un budget **n'est pas un échec** : le run se termine `completed` avec
`stopReason: budget:max_pages`. `ctx.frontier.take(n)` est déjà borné par ce qui
reste — ne comptez pas vous-même.

La planification est déclarée sur le job, pas dans le workflow :

```yaml
schedule:
  frequency: daily              # manual | hourly | daily | weekly
  window: { from: "08:00", to: "10:00" }
  timeZone: Europe/Paris        # sinon scheduler.timeZone, sinon UTC
  pagesPerRun: { min: 10, max: 100 }
```

---

## 6. Tester

Sans navigateur, avec `FakeBackend` :

```ts
const backend = new FakeBackend({
  routes: { 'https://e.com/': { body: '<html>…</html>' } },
});
const store = Store.memory();
const job = store.jobs.upsert({ name: 'test', workflow: 'mon-workflow' });

const outcome = await runWorkflow(monWorkflow, { store, job, browser: backend, dataDir });
expect(outcome.run.status).toBe('completed');
```

Modèle complet : `tests/e2e/workflow-run.test.ts`.

---

## 7. Ce que produit un run

```text
data/jobs/<job>/runs/<run-id>/
  report.md      lisible par un humain
  report.json    exploitable par une machine
  events.jsonl   écrit au fil de l'eau — lisible même si le run est tué
data/jobs/<job>/artifacts/
  …              fichiers collectés, provenance en base
```

`node dist/src/cli/main.js doctor` diagnostique un déploiement qui ne tourne pas.
