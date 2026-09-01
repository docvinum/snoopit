# snoopit

**Orchestrateur de visites web persistantes utilisant Chrome comme moteur d'exécution.**

`snoopit` exécute automatiquement et régulièrement des visites de sites web dans un
Chrome réel, sur un serveur Linux. Il se souvient de ce qu'il a déjà visité, reprend
un crawl interrompu là où il s'était arrêté, et produit des rapports et des fichiers
collectés avec leur provenance.

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

## État du projet

**Lot 1 terminé — squelette, état persistant et outillage.** Le runtime navigateur arrive au Lot 2.

| Lot | Contenu | Statut |
|---|---|---|
| 0 | Audit de `browser-agent`, décision, architecture cible, MVP | ✅ terminé |
| 1 | Squelette, tooling, SQLite, modèles, tests initiaux | ✅ terminé |
| 2 | Runtime navigateur minimal | à venir |
| 3 | Premier workflow de bout en bout | à venir |
| 4 | Scheduler, reprise, budgets | à venir |
| 5 | Recovery (heuristiques, puis LLM) | à venir |
| 6 | Déploiement et documentation agent | à venir |

---

## Démarrage

```bash
npm install
npm run build

cp snoopit.config.example.yaml snoopit.config.yaml   # optionnel : les défauts marchent
node dist/cli/main.js migrate    # crée data/snoopit.db
node dist/cli/main.js status     # configuration, version de schéma, jobs
```

Vérification complète (format, lint, typecheck, tests) :

```bash
npm run check
```

La suite de tests du Lot 1 s'exécute **sans navigateur et sans réseau** — c'est la
preuve que l'abstraction `BrowserBackend` tient.

---

## Deux cas d'usage

**`audit`** — visiter un site et produire un rapport : statuts HTTP, liens cassés,
images manquantes, redirections inattendues, changements de structure.

**`collect`** — visiter un site pour récupérer des contenus : texte, Markdown, JSON,
PDF, images. Chaque ressource conserve sa provenance : URL, dates de découverte,
de dernière visite et de collecte, hash de contenu, statut, fichiers produits.

---

## Principes de conception

1. **La source de vérité est SQLite, jamais le navigateur.** Chrome est un exécutant
   remplaçable ; l'état lui survit.
2. **Le fonctionnement nominal est déterministe** — DOM, sélecteurs, arbre
   d'accessibilité, navigation. Un run normal effectue zéro appel LLM.
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
| [`docs/BROWSER_AGENT_AUDIT.md`](docs/BROWSER_AGENT_AUDIT.md) | Audit de `zxcHolmes/browser-agent` et décision `fork` / `extraction` / `rewrite` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture cible, décisions structurantes, modèle d'état |
| [`docs/MVP.md`](docs/MVP.md) | Périmètre du MVP, test d'acceptation, séquence des lots |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Outillage, règles TypeScript, frontières d'architecture, tests |

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
