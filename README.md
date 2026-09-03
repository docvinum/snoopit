# snoopit

**Orchestrateur de visites web persistantes utilisant Chrome comme moteur d'exécution.**

`snoopit` exécute automatiquement et régulièrement des visites de sites web dans un
Chrome réel, sur un serveur Linux. Il se souvient de ce qu'il a déjà visité, reprend
un crawl interrompu là où il s'était arrêté, et produit des rapports et des fichiers
collectés avec leur provenance.

C'est un **navigateur automatisable et mémorisable pour agents** : un agent explore
une tâche via l'API, transforme cette exploration en workflow déterministe, puis
laisse `snoopit` le rejouer et le maintenir dans le temps.

Ce n'est pas un agent LLM qui décide de chaque clic. La navigation est **déterministe
et scriptable** ; un LLM n'intervient qu'en **mécanisme de récupération**, lorsqu'un
état inattendu apparaît.

```text
Coding agent  ->  workflows versionnés  ->  Browser Runtime  ->  Chrome  ->  sites web
                                             |
                                             +-- State DB (SQLite, source de vérité)
                                             +-- Scheduler
                                             +-- Budgets & Policies
                                             +-- Artifacts & Rapports
                                             +-- LLM Recovery (exception)
```
---

## Cas d’usage de référence

Snoopit est conçu pour automatiser des tâches de navigation web récurrentes lorsqu’une API n’existe pas, n’est pas suffisante ou ne donne pas accès au contenu recherché.

Cas d’usage de référence :

* **Collecte pour RAG** : récupérer automatiquement des contenus web, documents, PDF, images ou fichiers afin qu’ils puissent ensuite être ingérés par un système externe de RAG ou de gestion de connaissances.
* **Veille de sites sources** : visiter régulièrement des sites de référence, détecter les nouveautés, identifier les changements et télécharger les nouvelles ressources publiées.
* **Récupération périodique de fichiers** : automatiser l’accès à des fichiers ou datasets difficiles à obtenir via API, tout en conservant leur provenance et leur historique de collecte.
* **Suivi d’annonces** : collecter de nouvelles annonces, mémoriser leur état, identifier celles qui ont disparu ou été modifiées, détecter des variations telles qu’une baisse de prix, et faciliter la comparaison entre plusieurs portails.
* **Automatisation maintenable par agent** : les workflows Snoopit sont du code versionné, testable, reviewable et modifiable par des coding agents tels que Claude Code ou Codex.

Snoopit reste responsable de la navigation, de la collecte, de la mémoire de visite et de la provenance. L’analyse métier, l’indexation sémantique et l’exploitation des contenus collectés restent du ressort des systèmes aval.

---

## État du projet

**MVP complet — les six lots sont terminés.** Le système est déployable et documenté pour les agents de code.

| Lot | Contenu | Statut |
|---|---|---|
| 0 | Audit de `browser-agent`, décision, architecture cible, MVP | ✅ terminé |
| 1 | Squelette, tooling, SQLite, modèles, tests initiaux | ✅ terminé |
| 2 | Runtime navigateur minimal | ✅ terminé |
| 3 | Premier workflow de bout en bout | ✅ terminé |
| 4 | Scheduler, reprise, budgets | ✅ terminé — **jalon MVP** |
| 5 | Recovery (heuristiques, puis LLM) | ✅ terminé |
| 6 | Déploiement et documentation agent | ✅ terminé |

---

## Démarrage

```bash
npm install
npm run build

cp snoopit.config.example.yaml snoopit.config.yaml   # optionnel : les défauts marchent
node dist/src/cli/main.js migrate    # crée data/snoopit.db
node dist/src/cli/main.js status     # configuration, version de schéma, jobs
```

Lancer un workflow (exige un Chrome persistant joignable en CDP) :

```bash
node dist/src/cli/main.js workflows          # workflows disponibles
node dist/src/cli/main.js run example-audit  # un run, un rapport
node dist/src/cli/main.js due                # quels jobs sont dus, et sinon pourquoi
node dist/src/cli/main.js tick               # lance chaque job dû une fois
node dist/src/cli/main.js doctor             # ce déploiement est-il sain ?
```

Déploiement sur un serveur : [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Vérification complète (format, lint, typecheck, tests) :

```bash
npm run check
```

La suite de tests du Lot 1 s'exécute **sans navigateur et sans réseau** — c'est la
preuve que l'abstraction `BrowserBackend` tient.

---

## Deux types de workflow

**`audit`** — visiter un site et produire un rapport : statuts HTTP, liens cassés,
images manquantes, redirections inattendues, changements de structure.

**`collect`** — visiter un site pour récupérer des contenus : texte, Markdown, JSON,
PDF, images. Chaque ressource conserve sa provenance : URL, dates de découverte,
de dernière visite et de collecte, hash de contenu, statut, fichiers produits.

---

## À quoi ressemble un workflow

```ts
export default workflow({
  name: 'example-publications',
  budget: { maxPages: 50, maxLlmCalls: 0 },

  async run(ctx) {
    // Découverte
    const { page } = await ctx.visit(startUrl, { waitFor: '.publication-list' });

    const publications = await ctx.extract(page, {
      selector: '.publication',
      fields: { title: '.title', date: '.date', pdf: '.download@href' },
    });

    for (const publication of publications) {
      if (publication.pdf === null) continue;
      ctx.frontier.discover(publication.pdf, { kind: 'document' });
    }
    await page.close();

    // Collecte — consomme la frontier, reprenable indépendamment
    const collector = await ctx.browser.open(startUrl);
    for (const entry of ctx.frontier.take(50)) {
      await ctx.artifacts.collect(collector, entry.url, { dir: 'publications' });
      ctx.frontier.complete(entry);
    }
    await collector.close();
  },
});
```

Le workflow déclare son intention. Le runtime détient la mémoire, la provenance, les
événements et le rapport — un workflow ne peut pas oublier de les tenir à jour. Les
noms de champs sont typés : `publication.pdf` existe, `publication.pdfs` ne compile pas.

Exemples complets : [`workflows/`](workflows/).

---

## Principes de conception

1. **La source de vérité est SQLite, jamais le navigateur.** Chrome est un exécutant
   remplaçable ; l'état lui survit.
2. **Le fonctionnement nominal est déterministe** — DOM, sélecteurs, navigation.
   Un run normal effectue zéro appel LLM, et `llmCalls` figure dans chaque rapport
   pour le prouver. Le LLM n'intervient qu'en récupération, après échec des
   heuristiques déterministes.
3. **La reprise après interruption est une exigence de premier ordre**, pas une
   optimisation.
4. **Découverte et collecte sont séparées**, ce qui permet reprise, priorisation,
   déduplication et contrôle des budgets.
5. **Face à un blocage — CAPTCHA, 403 systématique, limitation explicite — le
   comportement est l'arrêt** : `STOP` + journalisation + rapport. Aucun mécanisme de
   contournement n'est conçu ni accepté.

Priorités, dans l'ordre : fiabilité, simplicité, reprise après interruption,
déterminisme, observabilité, maintenabilité par coding agent, extensibilité,
utilisation minimale du LLM.

---

## Documentation

| Document | Contenu |
|---|---|
| [`docs/USE_CASES.md`](docs/USE_CASES.md) | Cas d'usage de référence détaillés |
| [`docs/BROWSER_AGENT_AUDIT.md`](docs/BROWSER_AGENT_AUDIT.md) | Audit de `zxcHolmes/browser-agent` et décision `fork` / `extraction` / `rewrite` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture cible, décisions structurantes, modèle d'état |
| [`docs/MVP.md`](docs/MVP.md) | Périmètre du MVP, test d'acceptation, séquence des lots |
| [`docs/BILAN.md`](docs/BILAN.md) | Bilan lot par lot : décisions, enseignements, limites, reste à faire |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Outillage, règles TypeScript, frontières d'architecture, tests |
| [`docs/WORKFLOWS.md`](docs/WORKFLOWS.md) | Écrire un workflow : primitives, conventions, exemples |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Installation sur l'OptiPlex, systemd, sauvegarde du profil |
| [`docs/EXEMPLE-LEBONCOIN.md`](docs/EXEMPLE-LEBONCOIN.md) | Exemple de bout en bout : prérequis + prompt du coding agent pour un workflow leboncoin |
| [`docs/NOTE-LEBONCOIN-PREPARATION.md`](docs/NOTE-LEBONCOIN-PREPARATION.md) | Journal de la préparation `dell` : profil Chrome authentifié, transfert, portabilité, sauvegarde |
| [`AGENTS.md`](AGENTS.md) | Instructions pour Claude Code / Codex |
| [`skills/snoopit/SKILL.md`](skills/snoopit/SKILL.md) | Compétence : écrire un workflow |

---

## Origine

Le projet a démarré par un audit de [`zxcHolmes/browser-agent`](https://github.com/zxcHolmes/browser-agent)
(Apache-2.0). La décision retenue est une **extraction conceptuelle** : trois idées de
conception sont reprises — profil Chrome persistant et authentifié, CDP brut en
échappatoire de dernier recours, découpage d'API par verbes — **sans reprise de code**.
`snoopit` reste sous licence MIT pure. Le raisonnement complet figure dans l'audit.

---

## Licence

MIT — voir [`LICENSE`](LICENSE).
