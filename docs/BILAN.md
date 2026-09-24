# Bilan du MVP — `snoopit`, lots 0 à 6

> Rédigé à l'issue du Lot 6. Ce document dit ce qui a été fait, **ce qu'on a appris
> en le faisant**, ce qui a été délibérément écarté, et ce qui reste.
>
> Il est destiné à quiconque reprendra ce projet — humain ou agent — et cherchera à
> comprendre non pas *ce que fait* le code, mais *pourquoi il est ainsi*.

---

## Chiffres

| | Valeur |
|---|---|
| Lots livrés | 6 sur 6 |
| Runtime (`src/`) | 43 fichiers, 7 208 lignes |
| Workflows d'exemple | 5 fichiers, 445 lignes |
| Tests | 39 fichiers, 5 542 lignes, **445 tests** |
| Documentation | 10 fichiers, 2 487 lignes |
| Dépendances runtime | 5 (`better-sqlite3`, `playwright-core`, `linkedom`, `yaml`, `zod`) |

**105 tests passent sans navigateur ni réseau.** Ce n'est pas une commodité de CI :
c'est la preuve mécanique que l'abstraction navigateur tient.

---

## Lot 0 — Audit et décision

### Fait

Audit de `zxcHolmes/browser-agent`, décision documentée, architecture cible, périmètre
du MVP. Livrables : `BROWSER_AGENT_AUDIT.md`, `ARCHITECTURE.md`, `MVP.md`.

### Constats

Le projet amont : 5 commits sur une journée, ~7 500 lignes en trois langages, **zéro
test**, Apache-2.0.

- **La boucle LLM était le chemin unique.** Aucun chemin d'exécution sans modèle.
- **L'état critique vivait dans le navigateur.** Un `Map` en mémoire dans un service
  worker MV3, jamais réhydraté ; historique purgé à 24 h ; event store à 3 min.
- **Les téléchargements étaient absents.** `grep -ri download` : 0 occurrence.
- **Le proxy Go n'avait aucune authentification**, écoutait sur toutes les interfaces
  et exposait `eval` JS et CDP brut.

Couverture des exigences : **1 sur 15, partiellement**.

### Décision

**Extraction**, pas fork. Trois idées reprises, aucune ligne de code. Le dépôt reste
MIT pur.

### L'enseignement du lot

> **La contrainte que résout un composant peut ne pas exister sur votre cible.**

L'extension Chrome n'existe que pour éviter de relancer le navigateur d'un poste de
travail. Sur un serveur qu'on possède, on lance soi-même un Chrome persistant : le
profil authentifié est conservé, et le cycle de vie MV3, le relais Go et deux langages
disparaissent. Le grief amont contre Playwright (« instance stérile ») visait
`launch()`, pas `connectOverCDP()`.

Ne pas auditer aurait coûté un fork de 7 500 lignes sans test.

---

## Lot 1 — Squelette et état

### Fait

TypeScript strict, ESLint, Prettier, Vitest, CI. Schéma SQLite (`jobs`, `runs`,
`crawl_pages`, `crawl_frontier`, `artifacts`, `events`), migrations, six repositories,
canonicalisation d'URL, configuration validée. **130 tests, aucun navigateur.**

### Décisions structurantes

- **Les migrations appliquées sont immuables.** Un SQL modifié après application fait
  échouer le démarrage plutôt que de dériver en silence.
- **Aucun secret dans la configuration.** `llm.apiKeyEnv` porte le *nom* d'une
  variable d'environnement ; un `apiKey` en clair est rejeté par le schéma.
- **La canonicalisation est conservatrice.** Une fusion erronée perd des données en
  silence ; un dédoublement ne coûte qu'une visite. D'où `www.` non fusionné par
  défaut et rejet des `<link rel=canonical>` cross-origin.

### Avertissement laissé, et non suivi

J'ai signalé à ce lot que le `.gitignore` hérité d'un template Python contenait des
patrons dangereux, et vérifié avec `git status --ignored` : rien. **Le répertoire
concerné n'existait pas encore.** Je n'ai pas refait le contrôle après l'avoir créé
au Lot 2. Voir « la faute » plus bas.

---

## Lot 2 — Runtime navigateur

### Fait

Port `BrowserBackend`, `CdpBackend` (`playwright-core` en `connectOverCDP`),
`FakeBackend` (DOM réellement parsé). Primitives, statut HTTP, chaîne de redirection,
timeout explicite, `isHumanInteractable`, pipeline de téléchargement. **253 tests.**

### Décisions structurantes

- **Données, pas handles.** `query()` rend une valeur, les actions prennent des
  sélecteurs. Un handle vivant ferait fuir le backend dans chaque appelant et
  porterait des bugs de péremption. Coût assumé : pas de chaînage relatif à un
  élément.
- **La lib TypeScript `DOM` est activée** (playwright-core l'exige), et confinée par
  une règle ESLint interdisant `window`/`document` hors des deux adaptateurs.
- **L'échec est explicite.** Un timeout lève. L'amont résolvait au timeout, rendant
  une navigation échouée indistinguable d'une réussie.

### L'enseignement du lot

> **Une suite de conformité unique exécutée contre deux implémentations trouve ce
> qu'aucune relecture ne trouve.**

Les 59 tests tournent à l'identique sur le fake et sur un Chrome réel, avec un contenu
identique au octet près. Deux vrais bugs sont tombés immédiatement :

- Le fake **canonicalisait l'URL courante** — un navigateur ne canonicalise pas sa
  barre d'adresse. Attrapé parce que Chrome, lui, disait la vérité.
- `sanitizeSegment` laissait des `..` dans un nom de fichier issu d'une entrée
  hostile.

---

## Lot 3 — Premier workflow de bout en bout

### Fait

`workflow()` et `WorkflowContext`, runner, émetteur d'événements (base + `events.jsonl`
au fil de l'eau), rapports `.md` et `.json` issus d'une même fonction pure, deux
workflows d'exemple, `snoopit run`. **295 tests.**

### Décisions structurantes

- **Le workflow déclare, le runtime tient.** Mémoire, provenance, événements et
  rapport sont au runtime précisément pour qu'un workflow ne puisse pas oublier de
  les tenir à jour.
- **Un run est clos et rapporté exactement une fois, même quand le workflow lève.**
  Un run inexpliqué est un défaut, pas un cas limite.
- **`extractAll` est générique sur ses noms de champs.** `publication.pdfs` ne
  compile pas — la classe d'erreurs la plus probable dans du code généré est attrapée
  à la compilation.

### Trou trouvé dans le Lot 1

`tsconfig.json` n'incluait pas `workflows/`. Le code qu'un agent écrira n'était donc
pas type-checké — le pire endroit possible pour ce trou. Sa correction a immédiatement
révélé de vraies erreurs de typage.

### Bug trouvé

`visit()` appelait `markGone` puis `recordError`, qui l'écrasait. `gone` et `error`
sont deux constats différents et le plus précis doit gagner. Trouvé par le test de
bout en bout, qui a échoué **identiquement sur les deux backends** — signe que le
défaut était dans la logique, pas dans un adaptateur.

---

## Lot 4 — Scheduler, budgets et reprise *(jalon MVP)*

### Fait

Garde-budget par opération, fenêtres temporelles à jitter déterministe, `pagesPerRun`,
verrou anti-recouvrement par heartbeat, reprise des baux de runs morts, revisite.
**357 tests.**

### Le test d'acceptation, exécuté pour de vrai

Un processus enfant lance le CLI réel contre un Chrome réel et est tué par `SIGKILL`
au 6ᵉ document. Le run suivant termine le catalogue sans rien retélécharger ni sauter.

**Le `SIGKILL` importe** : aucun handler ne s'exécute, rien n'est vidé en sortie.
C'est la seule façon de savoir que la trace sur disque est durable, et non écrite par
un chemin d'arrêt bien élevé.

### Décisions structurantes

- **`maxPages` compte les unités de travail**, pas seulement les visites HTML : une
  page et un document valent chacun 1. Autrement un workflow de collecte reste sans
  borne réelle — et un budget qui ne borne rien est pire qu'absent.
- **Atteindre un budget n'est pas un échec.** Le run se termine `completed` avec un
  `stopReason` nommant la limite, et les limites figurent au rapport : sans quoi un
  run tronqué ressemble à un site qui aurait perdu ses pages.
- **Le heartbeat distingue vivant et mort.** Un fichier de verrou ne le peut pas. Un
  run abandonné est clos en `aborted`, jamais supprimé : il a travaillé, l'effacer
  ferait mentir la trace.
- **Le jitter est un mécanisme de répartition de charge**, pas de dissimulation. Il
  est déterministe, donc stable d'un réveil à l'autre.

### Bugs trouvés par le test d'acceptation

- **Les baux d'un run mort n'étaient récupérables qu'à l'expiration du minuteur.** Un
  run tué 3 s après un bail de 15 min immobilisait son travail un quart d'heure —
  exactement le blocage que le mécanisme devait empêcher. C'est la mort du run qui est
  le signal ; l'expiration n'est qu'un filet.
- **`maxLlmCalls: 0` interdisait la première visite de page**, parce que `check()`
  confondait toutes les limites. C'est pourtant la façon correcte de déclarer qu'un
  workflow n'utilise pas de LLM.

---

## Lot 5 — Recovery

### Fait

Heuristiques L1, port `LlmProvider` + adaptateur OpenAI-compatible + double scripté,
escalade L2 (DOM) / L3 (screenshot) / L4 (échec explicite), détection de blocage.
**434 tests.**

### Le critère, vérifié sur Chrome réel

Une modale masquant le contenu attendu est franchie **à L1, avec `llmCalls: 0`**. Le
compteur figure dans chaque rapport : la propriété est mesurée, pas espérée.

### Décisions structurantes

- **Le modèle choisit, il n'invente pas.** On lui présente les contrôles déjà jugés
  interactables ; un sélecteur inventé est refusé. Il ne peut pas atteindre ce que
  l'interface n'offre pas.
- **Un blocage ne consulte jamais le modèle.** CAPTCHA détecté → arrêt immédiat,
  `stopReason: blocked:captcha`. Le chemin « demander à un modèle de franchir un
  CAPTCHA » **n'existe pas dans le code**.
- **Les heuristiques ne cliquent jamais un contrôle qui engage** — connexion,
  abonnement, paiement, « gérer mes choix ». Les libellés sont comparés exactement :
  « Accepter les conditions et payer » n'est pas lu comme « Accepter ».
- **Sans clé API, le recovery s'arrête à L1** — configuration supportée, pas
  dégradée. Une clé absente ne doit jamais empêcher un crawl de démarrer.

### Correction

Une panne du provider levait une erreur de transport opaque jusqu'au workflow ; elle
dégrade désormais en L4. Le provider étant partagé par tous les niveaux, l'échec sort
de la phase LLM entière plutôt que de gaspiller un appel au niveau suivant.

---

## Lot 6 — Déploiement et documentation agent

### Fait

Unités systemd vérifiées par `systemd-analyze`, `install.sh` idempotent,
sauvegarde/restauration du profil Chrome (cycle testé, purge comprise),
`snoopit doctor`, `AGENTS.md`, `skills/snoopit/SKILL.md`, `DEPLOYMENT.md`.
**445 tests.**

### Décisions structurantes

- **Chrome tourne en continu ; le scheduler non.** Le scheduler ne garde aucun état
  entre deux passages — ce qui est dû se déduit de la base et de l'horloge — donc un
  processus qui démarre, travaille et sort n'a rien à perdre quand on le tue.
- **`install.sh` ne touche jamais au profil, à la base ni à la configuration
  existante.** Une mise à jour ne doit pas changer silencieusement le comportement du
  crawler.
- **Chrome est arrêté pendant la sauvegarde du profil.** Un instantané pris pendant
  une écriture LevelDB se restaure en profil corrompu — pire que pas de sauvegarde,
  car l'échec survient plus tard et personne ne le relie.
- **La documentation est liée au code par un test.** `docs-surface.test.ts` extrait
  chaque appel `ctx.…` et `page.…` montré dans la doc et vérifie qu'il existe.

### L'enseignement du lot — et de tout le projet

> **Écrire un nouveau cas d'usage depuis la seule documentation trouve ce que
> 434 tests n'avaient pas trouvé.**

`example-veille.ts` a été écrit en ne consultant que `SKILL.md`, sans lire `src/`. Il
a compilé du premier coup. Et il a révélé **deux vrais défauts du runtime** :

- **`enqueueDueRevisits()` ne fonctionnait pas.** Elle passait par `enqueue()`, qui
  refuse par conception de ressusciter une entrée `done` — ce refus empêche un crawl
  de boucler sur une page liée partout. Une revisite est l'intention inverse. Le
  mécanisme n'avait donc **jamais rien fait** pour une page déjà collectée,
  c'est-à-dire pour toute page qui intéresse une veille. Mon test du Lot 4 passait
  parce qu'il portait sur une page jamais passée par la frontier.
- **Le cache HTTP de Chrome masquait les changements.** Un run relisait une page
  modifiée et se voyait servir sa propre copie : hash identique, aucun changement
  rapporté. Pour un outil de veille, c'est le pire mode de défaillance — le crawl
  réussit et le rapport ment. Corrigé deux fois : `Network.setCacheDisabled` est
  accepté et **silencieusement ignoré** tant que `Network.enable` n'a pas été envoyé.

Les exemples existants empruntaient des chemins qui évitaient ces deux défauts.

---

## La faute

`src/runtime/downloads/` (paths.ts, download.ts) n'a **jamais été commité** entre le
Lot 2 et le Lot 6. Le patron `downloads/` du `.gitignore` hérité du template Python —
destiné au cache pip — l'avalait à chaque commit.

- Les fichiers existaient sur disque : mes tests passaient en local.
- **La CI était rouge depuis le Lot 2**, sur cinq lots.
- `git status` était propre. Rien ne désignait la cause.

J'avais signalé le risque au Lot 1 et vérifié — mais le répertoire n'existait pas
encore, et je n'ai pas refait le contrôle après l'avoir créé. C'est un utilisateur qui
l'a trouvé.

**Mesures prises :** patrons ancrés à la racine (`/build/`, `/lib/`…), et
`tests/unit/repo-hygiene.test.ts` qui échoue si un fichier source redevient ignoré ou
si un patron non ancré réapparaît. Ce mode de défaillance est pernicieux parce qu'il
est invisible : il méritait un contrôle mécanique, pas une note dans un document.

Effet de bord révélateur : Prettier respecte `.gitignore`, donc ce module échappait
aussi au formatage.

---

## Ce que ce projet a appris sur la manière de tester

Par ordre de rendement décroissant, mesuré en bugs réels trouvés :

1. **Écrire un nouveau cas d'usage depuis la seule documentation** (2 bugs, Lot 6).
2. **Une suite de conformité sur deux implémentations** (2 bugs, Lot 2).
3. **Tuer le processus pour de vrai** (2 bugs, Lot 4).
4. **Faire échouer volontairement le test pour vérifier qu'il attrape le bug** — fait
   pour le cache HTTP ; sans cela, un test de non-régression n'est qu'une opinion.

Les tests unitaires ont surtout confirmé des choses déjà justes. Les tests qui ont
trouvé des défauts sont ceux qui **empruntaient un chemin nouveau**.

---

## Limites assumées

| Limite | Pourquoi, et ce que ça coûte |
|---|---|
| Budget d'octets vérifié **après** transfert | La taille n'est connue qu'à réception. Protège le disque et l'itération suivante, pas le transfert en cours. |
| Téléchargements déclenchés par clic non couverts | `fetch` sur la session est déterministe ; un événement de download est une course. À ajouter si un site l'impose. |
| Profils réseau / proxy définis mais non implémentés | Hors MVP (spec §12). L'abstraction existe, l'adaptateur non. |
| Pas de chaînage relatif à un élément | Conséquence de « données, pas handles ». `extractAll` couvre le cas structuré. |
| Un seul Chrome, un run à la fois | Spec §22 : pas d'architecture distribuée prématurée. |
| Le fake ne modélise ni horloge ni layout | Délibéré : feindre un défilement ferait passer un test qui échouerait en vrai. Ces comportements sont vérifiés contre Chrome. |
| Pas d'arbre d'accessibilité brut | Le digest « contrôles interactables » sert le même but pour le recovery, et est identique sur les deux backends. |
| Fenêtres de planification en heure locale via `Intl` | L'heure d'été est gérée par la base du système. L'heure ambiguë du changement d'heure n'est pas traitée spécialement. |

---

## Reste à faire

**Court terme, si le système part en production :**

1. **Vérifier la CI verte** — elle était rouge depuis le Lot 2 ; la première exécution
   après ce merge est la première qui compte.
2. **Un vrai déploiement sur l'OptiPlex.** `install.sh` et les units sont écrits et
   vérifiés syntaxiquement, mais **jamais exécutés sur un hôte systemd réel** — ce
   conteneur n'en a pas.
3. **Une clé OpenRouter** si le recovery L2/L3 est voulu. Sans elle, L1 seul.

**Ensuite, par valeur décroissante :**

4. Profils réseau / proxy (tests géographiques).
5. Garde d'octets en flux, si les budgets de téléchargement deviennent serrés.
6. Téléchargements par clic, si un site l'impose.
7. Concurrence, seulement si le volume l'exige — et pas avant.

---

## Après le MVP — corrections d'audit et suivi d'annonces

Un audit du dépôt a relevé des défauts qu'aucun test ne couvrait ; chacun est corrigé
avec un test de non-régression.

| Défaut | Correction |
|---|---|
| `snoopit run` effaçait le planning d'un job et réactivait un job désactivé | `jobs.upsert` conserve tout champ non fourni |
| Un 403 / 429 / CAPTCHA sur un simple `visit` n'arrêtait pas le run | `visit` détecte le blocage (statut, widgets, DataDome) et arrête le run |
| Un PDF modifié à la même URL écrasait l'ancien fichier, dont l'artefact gardait l'ancien hash | la nouvelle version est écrite à côté (`versionedPath`) |
| La déduplication ne jouait qu'à chemin identique, et un contenu dédupliqué échappait au budget | déduplication par contenu, décidée avant toute écriture ; le transfert est toujours compté |
| Fenêtres de planification lues en UTC quel que soit le pays | `schedule.timeZone`, `scheduler.timeZone` (config) |
| Un workflow introuvable ou un Chrome injoignable interrompait tout le `tick` | `runDueJobs` isole chaque job |
| Les onglets oubliés s'accumulaient dans le Chrome persistant | le runner ferme les pages restées ouvertes |
| Une redirection vers la page de connexion était enregistrée comme contenu | `offSite`, et `visit(url, { session })` → `auth-required` |
| Script npm `snoopit` et résolution de `workflows/` avec espaces | chemins corrigés |

Ajouts : **`ctx.items`** (suivi par identifiant du site, avec diff et historique en
SQLite — tables `items` et `item_changes`, migration 2) et la **garde de session**
(`visit(url, { session })`, arrêt `auth-required`, code de sortie 3).

Puis le premier workflow réel, `leboncoin-recherches` : 47 recherches enregistrées,
revues par clic depuis `/my-searches`, annonces suivies par `ctx.items`,
disparitions détectées quand la liste est complète. Il a demandé une primitive :
`ctx.frontier.complete/fail(entry, { revisitAfter })`, pour que le travail atteint
sans `visit` revienne en file.

`defaultBudget` est désormais appliqué, limite par limite, sous le budget du
workflow : jusque-là, un workflow sans budget tournait sans aucune limite malgré la
configuration.

Reste connu : `browser.navigationTimeout` et les profils de navigateur sont validés
par la configuration mais pas encore appliqués ; une entrée de frontier en échec
n'est retentée que si le workflow le demande (`fail(entry, …, { revisitAfter })`).

---

## Ce qu'il ne faut pas défaire

Cinq propriétés portent la valeur du système. Les perdre le ramènerait à ce que
l'audit avait rejeté :

1. **SQLite est la source de vérité.** Le navigateur est jetable.
2. **Un run nominal fait zéro appel LLM**, et `llmCalls` le prouve à chaque rapport.
3. **Le job principal de la CI tourne sans navigateur.** S'il en exige un, une
   abstraction a fui.
4. **Un blocage arrête le run.** Aucun contournement — le chemin n'existe pas.
5. **L'identité d'une page est son URL canonique**, jamais un numéro de page.

`docs/CONVENTIONS.md` §8 et `AGENTS.md` les rappellent comme signaux d'alerte.
