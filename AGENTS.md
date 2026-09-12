# AGENTS.md — instructions pour Claude Code, Codex et assimilés

Ce dépôt est conçu pour être maintenu par des agents de code. Ce fichier dit ce
qu'il faut savoir avant de toucher quoi que ce soit.

---

## Ce qu'est ce projet

`snoopit` est un **orchestrateur de visites web persistantes** utilisant Chrome
comme moteur d'exécution. Il visite des sites régulièrement, se souvient de ce
qu'il a vu, reprend un crawl interrompu, et collecte des contenus avec leur
provenance.

**Ce n'est pas un agent LLM.** La navigation est déterministe et scriptable. Un
modèle n'intervient qu'en récupération, après échec des heuristiques.

---

## La tâche la plus fréquente

> « Crée un workflow qui visite ce site tous les jours, récupère les nouvelles
> publications PDF et les enregistre dans tel répertoire. »

**Réponse attendue : un seul fichier dans `workflows/`. Aucune modification du
runtime.**

Lisez [`skills/snoopit/SKILL.md`](skills/snoopit/SKILL.md) — il contient tout ce
qu'il faut pour cela. [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) est la référence
complète.

Si vous croyez devoir modifier `src/` pour écrire un workflow, **arrêtez-vous et
dites-le** : c'est soit une primitive réellement manquante (à discuter), soit un
malentendu sur l'API existante (à relire).

---

## Ordre de lecture

| Vous voulez | Lisez |
|---|---|
| Écrire un workflow | `skills/snoopit/SKILL.md`, puis `docs/WORKFLOWS.md` |
| Comprendre les choix d'architecture | `docs/ARCHITECTURE.md` |
| Savoir pourquoi le projet est ainsi | `docs/BROWSER_AGENT_AUDIT.md` |
| Connaître les conventions de code | `docs/CONVENTIONS.md` |
| Déployer | `docs/DEPLOYMENT.md` |
| Savoir ce qui reste à faire | `docs/MVP.md` |

---

## Commandes

```bash
npm run check     # format + lint + typecheck + tests — ce que fait la CI
npm run build     # compile src/ et workflows/ vers dist/
npm test          # tests seuls

node dist/src/cli/main.js doctor           # ce déploiement est-il sain ?
node dist/src/cli/main.js workflows        # workflows disponibles
node dist/src/cli/main.js run <workflow>   # un run, un rapport
node dist/src/cli/main.js due              # quels jobs sont dus, et sinon pourquoi
```

**Lancez `npm run check` avant chaque commit.** C'est exactement ce que la CI
exécute.

---

## Frontières à ne pas franchir

1. **Seuls les repositories parlent SQL.** Aucun `db.prepare()` hors de
   `src/state/repositories/`.
2. **Seul `src/runtime/browser/cdp.ts` importe `playwright-core`.** Aucun workflow,
   aucune règle métier ne construit une commande CDP.
3. **Aucun secret dans un objet de configuration.** La clé LLM est désignée par le
   *nom* d'une variable d'environnement.
4. **Le LLM n'est pas dans le chemin nominal.** Un run normal fait zéro appel. Si
   votre changement en ajoute un, justifiez-le explicitement.

---

## Signaux d'alerte

Si l'un de ces points devient vrai, quelque chose a dérivé :

1. Un workflow importe du CDP ou de Playwright → l'abstraction a fui.
2. Un run nominal appelle le LLM → dérive vers le pattern qu'on a rejeté.
3. Un test de logique métier exige un vrai navigateur → mauvais placement.
4. De l'état vit ailleurs que dans SQLite → la source de vérité est enfreinte.
5. La reprise dépend d'un numéro de page → l'identité est l'URL canonique.

---

## Tests

- `tests/unit/` — fonctions pures. Ni navigateur, ni réseau, ni disque.
- `tests/integration/` — plusieurs modules, sur SQLite `:memory:`.
- `tests/e2e/` — parcours complets contre les fixtures locales.

**Aucun test ne touche un site tiers, ni un vrai fournisseur LLM.** Les tests qui
exigent Chrome se sautent proprement quand il est absent ; le reste doit passer
sans navigateur — c'est la preuve que l'abstraction tient.

Un test nomme le comportement attendu, pas la fonction appelée.

---

## Pièges connus

- **Les imports relatifs portent l'extension `.js`**, y compris depuis un `.ts`
  (règle `NodeNext`). `import { x } from './y.js'` même si le fichier est `y.ts`.
- **`.gitignore` vient d'un template Python.** Les patrons de répertoires sont
  ancrés (`/build/`, `/lib/`) parce qu'un patron non ancré a déjà avalé
  `src/runtime/downloads/` pendant cinq lots. `tests/unit/repo-hygiene.test.ts`
  échoue si cela recommence — n'y touchez pas sans lire son en-tête.
- **La lib TypeScript `DOM` est activée** (playwright-core l'exige), mais une règle
  ESLint interdit `window`/`document` hors des adaptateurs navigateur.
- **Les pages sont indexées par URL canonique.** `store.pages.get(jobId, url)`
  attend l'URL canonique, pas l'URL brute.
