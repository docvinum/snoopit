# MVP et séquence des lots — `snoopit`

> Établi au Lot 0. Voir `docs/BROWSER_AGENT_AUDIT.md` (décision) et
> `docs/ARCHITECTURE.md` (conception).

---

## 1. Critère de réussite du MVP

Le MVP est atteint lorsque cette phrase est vraie de bout en bout :

> Un job planifié visite chaque jour une partie d'un catalogue, se souvient de ce
> qu'il a déjà vu, télécharge uniquement les nouveaux PDF, s'arrête proprement à
> l'épuisement de son budget, produit un rapport — **et reprend exactement là où il
> s'était arrêté après un `kill -9`.**

C'est la clause finale qui compte. C'est celle qu'aucune brique de `browser-agent`
ne pouvait satisfaire, et c'est elle qui définit le produit.

### Test d'acceptation

```text
1. Lancer un job sur le site de fixtures locales, budget = 10 pages.
2. Le tuer brutalement à la page 6.
3. Relancer.
4. Vérifier : reprise à la page 7, aucun re-téléchargement, aucune page sautée,
   les deux runs apparaissent dans `runs`, `report.md` de chacun est cohérent.
```

---

## 2. Périmètre du MVP

### Inclus

| Domaine | Périmètre |
|---|---|
| Runtime navigateur | `open`, `navigate`, `waitForReady`, `query`, `click`, `extract`, `screenshot`, `download` |
| État | SQLite : `jobs`, `runs`, `crawl_pages`, `crawl_frontier`, `artifacts`, `events` |
| Crawl | découverte → frontier → collecte ; canonicalisation URL ; dédup ; reprise |
| Scheduler | manuel, périodique, fenêtre temporelle avec jitter ; `pages_per_run` |
| Budgets | `max_pages`, `max_duration`, `max_download_bytes`, `max_errors`, `max_llm_calls` |
| Workflows | `workflow()` en TypeScript, deux exemples : un `audit`, un `collect` |
| Artifacts | Markdown, JSON, fichiers téléchargés, screenshots, avec provenance et hash |
| Observabilité | événements de domaine, `events.jsonl`, `report.md` + `report.json` |
| Recovery | L0 + L1 (heuristiques) ; interface `LlmProvider` définie mais L2/L3 au Lot 5 |
| Profils | `BrowserProfile` (viewport, locale, timezone, user-agent) |
| Tests | unitaires + intégration sans navigateur ; e2e sur fixtures locales |
| Déploiement | unités systemd, Chrome persistant sur `127.0.0.1` |
| Documentation agent | `AGENTS.md`, `skills/snoopit/SKILL.md` |

### Explicitement hors MVP

| Exclu | Raison |
|---|---|
| Extension Chrome | Audit §7 — ne résout aucun problème sur notre cible |
| Recovery LLM L2/L3 | Lot 5 ; le nominal doit d'abord être solide sans LLM |
| Profils réseau / proxy | Interface définie au Lot 1, implémentation après le MVP |
| Runs concurrents / distribution | §22 de la spec — pas d'architecture distribuée prématurée |
| Interface web | La CLI et les rapports suffisent |
| Docker | Ajouté seulement si systemd s'avère insuffisant |

---

## 3. Séquence des lots

### Lot 0 — Audit et décision ✅ *terminé*

Audit de `browser-agent`, décision **extraction (B)**, architecture cible, périmètre
du MVP. Livrables : `docs/BROWSER_AGENT_AUDIT.md`, `docs/ARCHITECTURE.md`, `docs/MVP.md`.

---

### Lot 1 — Squelette et état

Structure du dépôt, TypeScript strict, ESLint + Prettier, Vitest, CI GitHub Actions.
Chargement de configuration et secrets. Schéma SQLite avec migrations numérotées.
Dépôts pour `Job`, `Run`, `Page`, `Artifact`, `Event`. Canonicalisation d'URL.

*Terminé quand* : `npm test` passe en CI ; la canonicalisation d'URL et les
transitions d'état des pages sont couvertes ; `snoopit migrate` crée une base saine.

**Aucun navigateur n'est requis pour ce lot** — c'est délibéré et c'est ce qui valide
l'abstraction D3.

---

### Lot 2 — Runtime navigateur minimal

Port `BrowserBackend` + `CdpBackend` (`playwright-core` en `connectOverCDP`) +
`FakeBackend`. Primitives : `open`, `navigate`, `wait`, `query`, `click`, `extract`,
`screenshot`, `download`. `waitForReady` déterministe (jamais un `readyState` en
polling). Remontée du statut HTTP et de la chaîne de redirection — absents en amont,
requis par le workflow `audit`. `isHumanInteractable()`. Pipeline de téléchargement
avec hash et provenance.

*Terminé quand* : les primitives fonctionnent contre les fixtures locales ; le même
jeu de tests passe sur `FakeBackend` sans navigateur.

---

### Lot 3 — Premier workflow de bout en bout

Site HTML de fixtures (index paginé, PDF, 404, redirection, bannière cookies, image
manquante). `workflow()` et contexte d'exécution. Deux workflows : `example-audit` et
`example-publications`. Génération de `report.md` + `report.json`. Disposition des
artifacts sur disque.

*Terminé quand* : découverte → navigation → extraction → téléchargement → persistance
→ rapport s'exécute d'une traite et produit des artifacts corrects avec leur provenance.

---

### Lot 4 — Scheduler, reprise et budgets

Fenêtres temporelles avec jitter (distribution de charge, jamais de l'évasion),
`pages_per_run` min/max, priorisation de la frontier, verrous anti-recouvrement,
application des budgets avec arrêt propre, événement `BUDGET_REACHED`, revisite par
`next_visit_after`.

*Terminé quand* : **le test d'acceptation du §1 passe.** C'est le jalon du MVP.

---

### Lot 5 — Recovery

Heuristiques L1 (bannières cookies, modales, overlays, newsletter, murs de login).
Interface `LlmProvider` + adaptateur OpenRouter. Recovery L2 sur DOM / arbre a11y.
L3 multimodal avec screenshot. L4 échec explicite. Détection de blocage → `STOP` +
journalisation + rapport.

*Terminé quand* : un overlay injecté dans les fixtures est franchi par L1 **sans
appel LLM** ; l'escalade et le budget LLM sont testés avec un provider simulé.

---

### Lot 6 — Déploiement et documentation agent

Unités systemd, script d'installation, sauvegarde/restauration du profil Chrome.
`AGENTS.md`, `skills/snoopit/SKILL.md`, guide de rédaction de workflow.

*Terminé quand* : un coding agent produit un workflow fonctionnel **à partir de la
seule documentation, sans modifier le runtime** — l'objectif énoncé au §18 de la spec.

---

## 4. Méthode par lot

Pour chaque lot : auditer l'existant → annoncer les choix structurants → implémenter →
tester → exécuter les tests → mettre à jour la documentation → commit cohérent.

Les décisions techniques réversibles sont tranchées sans demander confirmation, en
privilégiant simplicité, maintenabilité et découplage. Les hypothèses sont documentées.

---

## 5. Signaux d'alerte à surveiller

Indicateurs qui signaleraient une dérive vers ce que l'audit nous a appris à éviter :

1. **Un workflow importe du CDP ou de Playwright** → l'abstraction D3 a fui.
2. **Un run nominal appelle le LLM** → nous glissons vers le pattern de l'upstream.
3. **Un test a besoin d'un vrai navigateur pour de la logique métier** → mauvais placement.
4. **De l'état vit ailleurs que dans SQLite** → D4 est enfreint.
5. **La reprise se met à dépendre d'un numéro de page** → §8 de la spec est enfreint.
