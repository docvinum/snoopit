# Écrire un workflow

> Guide d'écriture des workflows `snoopit`. Destiné aux humains **et** aux coding
> agents. La compétence complète (`skills/snoopit/SKILL.md`) arrive au Lot 6 ; ce
> document en est la base.

L'objectif : un utilisateur demande *« visite ce site tous les jours, récupère les
nouvelles publications PDF et range-les dans tel répertoire »*, et un coding agent
produit le workflow correspondant **sans modifier le runtime**.

---

## 1. Anatomie

Un workflow est un fichier TypeScript dans `workflows/`, exportant par défaut un
appel à `workflow()` :

```ts
import { workflow } from '../src/runtime/workflow/types.js';

export default workflow({
  name: 'nom-du-workflow',
  type: 'collect',              // ou 'audit'
  description: 'Une phrase.',
  budget: { maxPages: 50, maxDuration: '10m', maxLlmCalls: 0 },

  async run(ctx) {
    // ...
    return { /* résumé, inclus tel quel dans report.json */ };
  },
});
```

Le fichier est compilé avec le projet (`npm run build`) : un workflow qui ne
type-checke pas n'atteint jamais un run.

---

## 2. Ce que le runtime fait pour vous

Un workflow **déclare son intention**. Il ne tient ni l'état, ni la provenance, ni
les événements — c'est le rôle du runtime, précisément pour qu'un workflow ne puisse
pas oublier de le faire.

| Vous écrivez | Le runtime fait |
|---|---|
| `ctx.visit(url)` | Ouvre, enregistre la visite, calcule le hash de contenu, détecte le changement, émet `PAGE_VISITED` / `CONTENT_CHANGED` / `HTTP_ERROR` |
| `ctx.frontier.discover(url)` | Déduplique par URL canonique, crée la page, émet `PAGE_DISCOVERED` |
| `ctx.artifacts.collect(page, url)` | Télécharge via la session de la page, hash, écrit sur disque, enregistre la provenance, émet `ARTIFACT_CREATED` |
| `return { ... }` | Est repris tel quel dans `report.json` |

Vous n'écrivez jamais de SQL, jamais de CDP, jamais de chemin de fichier absolu.

---

## 3. Les primitives

### Visiter

```ts
const { page, navigation, changed, firstVisit } = await ctx.visit(url, {
  waitFor: '.publication-list',   // attente déterministe d'un sélecteur
  timeoutMs: 30_000,
  record: true,                   // false pour ne pas mémoriser cette visite
});
```

`navigation` porte `status`, `redirectChain` et `ok`. **Vous devez fermer la page**
(`await page.close()`).

`changed` est vrai quand le hash de contenu diffère de la visite précédente — c'est
le signal de veille.

### Découvrir

```ts
ctx.frontier.discover(url, {
  kind: 'document',        // 'page' | 'asset' | 'document'
  priority: 50,            // plus bas = plus tôt (défaut 100)
  meta: { title, date },   // conservé et relu au moment de la collecte
});
ctx.frontier.discoverAll(urls);   // renvoie le nombre de nouveautés
```

Idempotent : redécouvrir une URL déjà traitée ne la remet **pas** en file. C'est ce
qui empêche un crawl de boucler sur une page liée depuis toutes les autres.

### Collecter

```ts
for (const entry of ctx.frontier.take(50)) {
  try {
    const { artifact, deduplicated } = await ctx.artifacts.collect(collector, entry.url, {
      dir: 'publications',
    });
    ctx.frontier.complete(entry);
  } catch (error) {
    ctx.frontier.fail(entry, String(error));   // retenté au prochain run
  }
}
```

### Extraire

```ts
const rows = await ctx.extract(page, {
  selector: '.publication',
  fields: { title: '.title', url: '.title@href', date: '.date' },
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

Les noms de champs sont **typés** : `rows[0].title` existe, `rows[0].titel` ne
compile pas. Un champ absent vaut `null`, jamais une exception.

### Produire

```ts
await ctx.artifacts.writeJson('resultats.json', data);
await ctx.artifacts.writeMarkdown('resume.md', texte);
await ctx.artifacts.screenshot(page, 'accueil.png');
```

---

## 4. Règles

1. **Découverte et collecte sont deux phases.** Alimentez la frontier, puis
   consommez-la. C'est ce qui rend possibles la reprise, la priorisation et la
   déduplication (spec §15).
2. **Pas de LLM dans le chemin nominal.** Un run normal fait zéro appel. Déclarez
   `maxLlmCalls: 0` quand c'est vrai — cela documente l'intention et la fait
   respecter.
3. **N'interagissez qu'avec ce qu'un humain peut atteindre.** `click()` refuse un
   élément invisible, `inert`, `aria-hidden` ou désactivé. Ne forcez pas
   (`force: true`) : le refus signale presque toujours que le workflow a dérivé.
4. **Fermez vos pages.** `await page.close()`, y compris en cas d'erreur (`finally`).
5. **Une ressource illisible n'arrête pas la collecte.** `ctx.frontier.fail(entry, …)`
   et on continue ; le run reste vert, le problème apparaît dans le rapport.
6. **Face à un blocage — CAPTCHA, 403 systématique, limitation explicite — arrêtez.**
   Journalisez et rapportez. Aucun contournement n'est à écrire, et aucun ne sera
   accepté en revue.
7. **Ne dépendez pas d'un numéro de page.** L'identité est l'URL canonique.

---

## 5. Tester un workflow

Sans navigateur, avec `FakeBackend` :

```ts
const backend = new FakeBackend({ routes: { 'https://e.com/': { body: '<html>…</html>' } } });
const store = Store.memory();
const job = store.jobs.upsert({ name: 'test', workflow: 'mon-workflow' });

const outcome = await runWorkflow(monWorkflow, { store, job, browser: backend, dataDir });

expect(outcome.run.status).toBe('completed');
```

Un test de workflow doit porter sur la logique d'extraction et de collecte, pas sur
le démarrage de Chrome. Voir `tests/e2e/workflow-run.test.ts`.

---

## 6. Lancer

```bash
npm run build
node dist/src/cli/main.js workflows
node dist/src/cli/main.js run mon-workflow
```

Chaque run produit :

```text
data/jobs/<job>/runs/<run-id>/
  report.md      lisible par un humain
  report.json    exploitable par une machine
  events.jsonl   écrit au fil de l'eau — lisible même si le run est tué
data/jobs/<job>/artifacts/
  …              les fichiers collectés, avec leur provenance en base
```
