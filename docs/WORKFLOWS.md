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

## 4. Budgets, planification et reprise

Un workflow déclare son budget ; le runtime l'applique.

```ts
budget: { maxPages: 50, maxDuration: '20m', maxDownloadBytes: 500_000_000, maxLlmCalls: 0 }
```

`maxPages` compte les **unités de travail** : une visite de page et un document
collecté valent chacun 1. Compter seulement les visites HTML laisserait un workflow
de collecte pratiquement sans borne.

Atteindre un budget **n'est pas un échec** : le run se termine `completed` avec un
`stopReason` du type `budget:max_pages`, et les limites en vigueur figurent dans le
rapport — sans quoi un run tronqué ressemble à un site qui aurait perdu des pages.

`ctx.frontier.take(n)` est déjà borné par le budget restant et par `pagesPerRun` :
inutile de compter vous-même, le runtime refuse de réserver du travail qu'il ne
pourra pas finir.

### Reprise

Rien de particulier à écrire. Un run tué laisse ses entrées réservées ; le run suivant
constate que le run propriétaire est mort (heartbeat périmé), le clôt en `aborted` et
remet son travail en file. La déduplication de la frontier fait le reste : ce qui est
`done` n'est jamais refait.

La seule règle : **redécouvrez librement**. `ctx.frontier.discover()` sur une URL déjà
traitée ne la remet pas en file, donc reparcourir l'index à chaque run est correct et
attendu.

### Revisite

```ts
await ctx.visit(url, { revisitAfter: '7d' });      // marque la prochaine échéance
const requeued = ctx.frontier.enqueueDueRevisits(); // au DÉBUT du run
```

Appelez `enqueueDueRevisits()` **avant** de visiter quoi que ce soit : une visite
rafraîchit `next_visit_after`, donc vérifier après ne trouverait jamais rien.

### Planification

Déclarée sur le job, pas dans le workflow :

```yaml
schedule:
  frequency: daily          # manual | hourly | daily | weekly
  window: { from: "08:00", to: "10:00" }
  pagesPerRun: { min: 10, max: 100 }
```

Le moment exact dans la fenêtre est jitté de façon déterministe à partir de l'id du
job et de la période : stable (un job ne dérive pas), et différent d'un job à l'autre.
C'est un mécanisme de **répartition de charge**, pas de dissimulation.

`snoopit due` explique pour chaque job s'il est dû, et sinon pourquoi.

---

## 5. Recovery — quand la page n'est pas celle attendue

Le pattern visé (spec §5) :

```text
script -> script -> état inattendu -> recovery -> retour au script
```

Le recovery est un **garde**, pas une étape. `ctx.recover()` rend la main
immédiatement si l'état attendu est déjà là : en protéger une action ne coûte rien
sur le chemin nominal.

```ts
await ctx.recover(page, {
  goal: 'Accéder à la liste des publications',
  expectedState: { selector: '.publication-list' },
  allowedActions: ['click', 'scroll', 'close_overlay'],
  maxSteps: 4,
});
```

### Les niveaux

```text
L0  votre script                 — le chemin nominal
L1  heuristiques déterministes   — overlays, scroll. Aucun appel LLM.
L2  LLM sur un digest DOM        — texte seul, contexte minimal
L3  LLM + screenshot             — dernier recours, le plus coûteux
L4  échec explicite              — RecoveryFailedError, journalisé et rapporté
```

L'escalade est **monotone et budgétée** : elle s'arrête dès que l'état attendu
apparaît. Un run qui ne rencontre pas de surprise n'atteint jamais L2, et `llmCalls`
dans le rapport le prouve.

Sans provider configuré, le recovery s'arrête à L1 — configuration parfaitement
valide, qui couvre l'écrasante majorité des obstacles.

### Garde-fous

- Le modèle **choisit parmi** les contrôles qu'on lui a montrés — tous jugés
  interactables par un humain. Un sélecteur inventé est refusé.
- Une action hors de `allowedActions` est refusée.
- Une réponse illisible est une étape échouée, jamais un crash.
- Un provider en panne dégrade en L4, pas en erreur de transport opaque.
- Chaque appel est décompté de `maxLlmCalls` **avant** d'être émis.

### Overlays seuls

Quand vous savez qu'il n'y a qu'une bannière à écarter, inutile de passer par le
recovery :

```ts
await ctx.dismissOverlays(page);   // déterministe, jamais de LLM
```

Les heuristiques ne cliquent jamais un contrôle qui engage — « Se connecter »,
« S'abonner », « Payer », « Gérer mes choix ». Un workflow qui doit se connecter le
fait dans son propre script, délibérément.

### Blocage : on s'arrête

Si le site oppose un CAPTCHA, un 403 ou une limitation explicite, le recovery lève
`BlockedError` **sans consulter le modèle**. Le run se termine `completed` avec
`stopReason: blocked:<raison>` — un constat rapporté, pas un échec à retenter.

Aucun contournement n'est à écrire, et aucun ne sera accepté en revue.

---

## 6. Règles

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
6. **Face à un blocage, arrêtez.** Le runtime le détecte et le rapporte
   (cf. §5) ; ne le contournez pas.
7. **Ne forcez jamais un appel LLM là où une heuristique suffit.** Déclarez
   `maxLlmCalls: 0` quand le workflow doit s'en passer : cela documente l'intention
   *et* la fait respecter.
8. **Ne dépendez pas d'un numéro de page.** L'identité est l'URL canonique.

---

## 7. Tester un workflow

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

## 8. Lancer

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
