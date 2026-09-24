# Architecture cible — `snoopit`

> Statut : proposition arrêtée au Lot 0, à la suite de `docs/BROWSER_AGENT_AUDIT.md`.
> Les décisions techniques réversibles sont tranchées ici ; les hypothèses sont explicites.

---

## 1. Définition du produit

`snoopit` est un **orchestrateur de visites web persistantes utilisant Chrome comme
moteur d'exécution**.

Ce n'est pas une extension, pas un agent LLM, pas un framework de scraping généraliste.
Sa propriété distinctive est la **mémoire** : il sait ce qu'il a déjà vu, ce qui a
changé, ce qu'il lui reste à visiter — et il le sait après un redémarrage.

Corollaire de conception, non négociable :

> **La source de vérité est SQLite, jamais le navigateur.**
> Chrome est un exécutant remplaçable et jetable. L'état lui survit.

---

## 2. Vue d'ensemble

```text
   Coding agent (Claude Code / Codex)
                |
                | écrit et maintient (jamais requis pendant un run)
                v
   workflows/*.ts          profiles/*.yaml
                |                |
                v                v
   +-----------------------------------------------+
   |                  RUNTIME                      |
   |                                               |
   |  Scheduler  ->  Runner  ->  Workflow API      |
   |                   |                           |
   |                   +-- Budgets (garde)         |
   |                   +-- Events  (observabilité) |
   |                   +-- Recovery L0..L4         |
   |                                               |
   +------------|--------------------|-------------+
                |                    |
                v                    v
         State (SQLite)        BrowserBackend (port)
         source de vérité             |
                                      v
                            CdpBackend (adaptateur)
                                      |
                                      v
                      Chrome persistant (systemd, OptiPlex)
                                      |
                                      v
                                Sites web
                                      |
                                      v
                       Artifacts (data/, système de fichiers)
```

**Sens de circulation** : le runtime lit et écrit l'état, pilote le navigateur via un
port abstrait, et produit des artifacts. Le navigateur ne détient rien de durable.

---

## 3. Décisions structurantes

### D1 — TypeScript / Node.js, langage unique

La spec impose des workflows TypeScript (§4). Un runtime dans un autre langage
imposerait une frontière de sérialisation au milieu de la boucle chaude.
L'upstream utilise trois langages pour 7,5 kLOC ; nous en utilisons un.

### D2 — Chrome persistant piloté en CDP, pas d'extension

Conclusion §7 de l'audit. Chrome tourne en permanence sous `systemd` avec un
`--user-data-dir` dédié et `--remote-debugging-port` lié à `127.0.0.1`. Le profil est
persistant : cookies et sessions survivent aux redémarrages — le bénéfice que
l'extension apportait, sans son cycle de vie MV3 ni son état volatile.

**Driver retenu : `playwright-core` en `connectOverCDP`.** À noter, car c'est
contre-intuitif au vu du README amont : le grief de `browser-agent` contre Playwright
(« instance stérile, sans cookies ») vise `launch()`. `connectOverCDP()` **s'attache à
un Chrome déjà lancé** — donc au nôtre, persistant et authentifié. Nous obtenons une
bibliothèque mature (attentes d'événements, codes HTTP, interception réseau,
téléchargements, arbre d'accessibilité) *et* le profil persistant.

Le paquet `playwright-core` n'embarque aucun binaire : nous utilisons le Chrome système.

**Révision : un second moteur, par extension** (`browser.backend: extension`). Le
besoin est apparu avec leboncoin : naviguer dans un Chrome **visible**, où l'on se
connecte à la main, sans port de débogage. L'extension ne remplace pas le runtime :
elle en est un moteur. snoopit ouvre un WebSocket sur `127.0.0.1` le temps d'un run ;
l'extension s'y connecte, les deux côtés prouvent qu'ils détiennent le jeton
d'appairage (HMAC mutuel, jeton jamais transmis), puis l'extension exécute les
opérations du port, **uniquement dans les onglets qu'elle a ouverts**. Le code
exécuté dans la page est le même pour les deux moteurs
(`src/runtime/browser/page-functions.ts`) ; la même suite de conformité les valide.
Planning, frontier, SQLite, budgets et rapports ne bougent pas. Déploiement :
`docs/DEPLOYMENT.md` §9.

### D3 — La couche CDP est isolée derrière un port

La spec proscrit la « dépendance métier directe à Chrome CDP » (§22). Aucun workflow,
aucune règle métier ne touche le CDP ni l'API Playwright. Tout passe par
`BrowserBackend` / `PageHandle`.

```ts
// runtime/browser/backend.ts — le port
export interface BrowserBackend {
  open(url: string, opts?: OpenOptions): Promise<PageHandle>;
  close(): Promise<void>;
}

export interface PageHandle {
  url(): string;
  status(): number | null;          // absent chez l'upstream, requis pour `audit`
  redirectChain(): string[];
  waitForReady(opts?: ReadyOptions): Promise<void>;
  query(selector: string): Promise<ElementHandle | null>;
  queryAll(selector: string): Promise<ElementHandle[]>;
  extractAll(spec: ExtractSpec): Promise<Record<string, string>[]>;
  click(selector: string): Promise<void>;
  screenshot(opts?: ShotOptions): Promise<Buffer>;
  download(target: string, dest: string): Promise<DownloadResult>;
  html(): Promise<string>;
  accessibilityTree(): Promise<AxNode>;   // support du niveau de recovery L2
  cdp(method: string, params?: object): Promise<unknown>;  // échappatoire documentée
}
```

Trois adaptateurs : `CdpBackend` (Chrome sous Xvfb, en CDP), `ExtensionBackend`
(Chrome visible, par l'extension snoopit, sans port de débogage — voir D2) et
`FakeBackend` (tests, sans navigateur). Le port réel a évolué depuis cette esquisse
(instantanés plutôt que poignées, pas d'échappatoire CDP) : `src/runtime/browser/types.ts`
fait foi.

Bénéfice immédiat : la majorité de la suite de tests s'exécute **sans navigateur**.

### D4 — SQLite est la source de vérité

`better-sqlite3` : synchrone, sans serveur, transactionnel, trivial à sauvegarder.
Mode WAL. Migrations numérotées dès le premier jour. La base vit **hors** du profil
Chrome, pour que R1 (corruption de profil) ne détruise jamais l'état.

### D5 — Découverte et collecte sont séparées

Conformément à §15 de la spec. La découverte alimente `crawl_frontier` ; la collecte
la consomme. Les deux phases sont reprenables indépendamment, ce qui rend possibles la
priorisation, la déduplication, le contrôle de budget et le retraitement ciblé.

### D6 — Le LLM est un mécanisme de récupération, jamais un pilote

Un run nominal effectue **zéro appel LLM**. C'est une métrique suivie, pas un
espoir. Le budget `max_llm_calls` par défaut est bas (3).

### D7 — Blocage ⇒ arrêt

Face à un CAPTCHA, un 403 systématique ou une limitation explicite : `STOP` +
journalisation + rapport. La détection a lieu dès `ctx.visit` (statut 403/429,
widgets de challenge) puis dans le recovery ; un workflow n'a rien à écrire pour
s'arrêter. Une session expirée (mur de connexion là où un workflow a déclaré une page
réservée aux connectés) arrête le run de la même façon, en `auth-required`. Aucun
mécanisme de contournement n'est conçu ni accepté en contribution. Les profils réseau servent des besoins légitimes (tests géographiques,
routage, résilience), pas l'évasion.

---

## 4. Structure du dépôt

```text
snoopit/
  src/
    runtime/
      browser/        BrowserBackend (port), CdpBackend, FakeBackend, pool d'onglets
      navigation/     waitForReady, canonicalisation URL, redirections, isHumanInteractable
      extraction/     extractAll, mapping de champs, text/markdown, hash de contenu
      downloads/      pipeline de téléchargement, provenance, dédup par hash
      recovery/       niveaux L0..L4, heuristiques, overlays, providers LLM
      budget/         garde de budget de run
      events/         bus d'événements de domaine, écriture JSONL
      workflow/       workflow(), contexte d'exécution, runner
    scheduler/        fenêtres temporelles, jitter, sélection du prochain run, verrous
    state/            schéma SQLite, migrations, dépôts (jobs/runs/pages/frontier/...)
    outputs/          rapports Markdown & JSON, disposition des artifacts
    config/           chargement de configuration, secrets, validation
    cli/              snoopit run | schedule | inspect | migrate
  workflows/          workflows utilisateur, versionnés (TypeScript)
  profiles/
    browser/          desktop-chrome.yaml, mobile-chrome.yaml
    network/          direct.yaml, proxy-fr.yaml
  skills/
    snoopit/          SKILL.md — comment un coding agent écrit un workflow
  tests/
    unit/             scheduler, frontier, URL, budgets, extraction, recovery
    fixtures/         site HTML local servi en CI
    e2e/              parcours complets sur les fixtures
  docs/
  data/               runtime, ignoré par git
  deploy/             unités systemd, Docker le cas échéant
```

Écart assumé par rapport à la structure suggérée en §21 de la spec : `extension/` est
absent (décision D2), et le code applicatif est regroupé sous `src/` pour une
configuration TypeScript unique.

---

## 5. Modèle d'état

```text
jobs           un workflow + son profil + sa planification
runs           une exécution d'un job (budgets, issue, horodatages)
crawl_pages    ce que nous savons d'une URL, à travers tous les runs
crawl_frontier ce qu'il reste à faire, avec priorité et tentatives
artifacts      ce que nous avons produit, relié à sa page source
events         ce qui s'est passé, structuré et interrogeable
items          ce que nous suivons par l'identifiant du site (annonce, produit)
item_changes   l'historique de chaque item : apparition, changement, disparition, retour
```

`crawl_pages` — le cœur mémoire, conforme à §7 de la spec :

```sql
CREATE TABLE crawl_pages (
  id              INTEGER PRIMARY KEY,
  job_id          TEXT NOT NULL,
  url             TEXT NOT NULL,
  canonical_url   TEXT NOT NULL,       -- clé de déduplication réelle
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  last_visited_at TEXT,
  content_hash    TEXT,                -- détecte CONTENT_CHANGED
  status          TEXT NOT NULL,       -- discovered|visited|changed|gone|error|revisit
  http_status     INTEGER,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  next_visit_after TEXT,               -- pilote la revisite
  UNIQUE (job_id, canonical_url)       -- l'identité est canonique, pas textuelle
);
```

**La clé d'identité est `(job_id, canonical_url)`, jamais un numéro de page.**
C'est ce qui rend la reprise robuste aux insertions, disparitions, réordonnancements
et duplications (§8 de la spec). Un run reprend en interrogeant la frontier — « que
reste-t-il à faire ? » — et non en comptant les pages déjà traitées.

Canonicalisation (`runtime/navigation/canonical.ts`) : minuscule sur le schéma et
l'hôte, port par défaut retiré, fragment retiré, paramètres de suivi retirés
(`utm_*`, `fbclid`, `gclid`), paramètres restants triés, `/index.html` normalisé,
`<link rel="canonical">` respecté lorsqu'il est présent et de même origine. Fonction
pure, donc entièrement testable — première cible de tests du Lot 1.

---

## 6. API de workflow (esquisse du MVP)

Volontairement non figée (§4 de la spec). Point de départ :

```ts
export default workflow({
  name: "example-publications",

  budget: { maxPages: 100, maxDuration: "20m", maxLlmCalls: 3 },

  async run(ctx) {
    const page = await ctx.browser.open("https://example.com/publications");
    await page.waitForReady();
    await page.dismissCommonOverlays();          // heuristique L1, sans LLM

    const items = await page.extractAll({
      selector: ".publication",
      fields: { title: ".title", url: "a@href", date: ".date" },
    });

    for (const item of items) {
      await ctx.frontier.discover(item.url, { kind: "publication", meta: item });
    }

    for await (const target of ctx.frontier.take({ max: 50 })) {
      const doc = await ctx.browser.open(target.url);
      await ctx.artifacts.download(doc, { dir: "publications/" });
    }

    return { discovered: items.length };
  },
});
```

Propriétés voulues : le workflow **déclare** son intention ; le runtime détient les
budgets, la persistance, la provenance et les événements. Le workflow ne connaît ni
SQLite, ni le CDP, ni le proxy, ni le LLM.

---

## 7. Modèle de recovery

```text
L0  script déterministe          — chemin nominal, 0 appel LLM
L1  heuristiques locales         — bannières cookies, modales, scroll, retry
L2  LLM sur DOM / arbre a11y     — texte seul, contexte minimal
L3  LLM multimodal + screenshot  — dernier recours, le plus coûteux
L4  échec explicite              — journalisé, rapporté, arrêt propre
```

L'escalade est **monotone et budgétée**. `recover()` reçoit un objectif, un état
attendu, une liste blanche d'actions et un `maxSteps` ; il retourne le contrôle au
script dès que l'état attendu est atteint. Le provider LLM est une interface
(`LlmProvider`) ; OpenRouter est le premier adaptateur, tout endpoint
OpenAI-compatible est accepté ; la clé vit dans la configuration ou les secrets, jamais
dans le code.

Un point retenu de l'upstream : le contexte du modèle est élagué par **unités
atomiques** (message assistant + ses résultats d'outils), jamais message par message.

---

## 8. Observabilité

Un `events.jsonl` par run, plus une table `events` interrogeable. Types conformes à
§17 de la spec : `RUN_STARTED`, `PAGE_DISCOVERED`, `PAGE_VISITED`, `CONTENT_CHANGED`,
`ARTIFACT_CREATED`, `HTTP_ERROR`, `RECOVERY_STARTED/SUCCEEDED/FAILED`,
`BUDGET_REACHED`, `BLOCKED`, `AUTH_REQUIRED`, `ITEM_NEW/CHANGED/GONE/RETURNED`,
`RUN_COMPLETED`, `RUN_FAILED`.

Chaque run produit **un rapport lisible par un humain** (`report.md`) *et* **un rapport
exploitable par une machine** (`report.json`). Les journaux texte complètent, ils ne
remplacent pas.

Disposition (§16 de la spec) :

```text
data/
  snoopit.db
  jobs/
    example-publications/
      artifacts/
      runs/
        2026-08-31T080000Z/
          report.md
          report.json
          events.jsonl
          screenshots/
```

---

## Intégrations aval

Snoopit ne doit pas devenir un système de RAG, une base de connaissances ou un moteur d’analyse métier.

Sa responsabilité s’arrête à :

```text
discovery
→ navigation
→ collecte
→ mémoire de visite
→ détection de changements
→ provenance
→ artifacts
```

Les artifacts produits peuvent ensuite être consommés par d’autres systèmes.

### Intégration avec un système de RAG ou de mémoire

Une collecte Snoopit peut devenir automatiquement une source d’ingestion pour un système externe tel que 2ndBrAIn.

Exemple :

```text
site source
   ↓
Snoopit
   ↓
document + metadata + provenance + hash
   ↓
pipeline d’ingestion
   ↓
2ndBrAIn / RAG / moteur de recherche
```

Snoopit doit fournir suffisamment de métadonnées pour permettre au système aval de :

* identifier la source originale ;
* détecter si un contenu est nouveau ou modifié ;
* éviter les réingestions inutiles ;
* conserver un historique ;
* relier plusieurs versions d’une même ressource.

### Suivi longitudinal

Pour des objets évolutifs comme des annonces immobilières, Snoopit peut maintenir la mémoire technique de visite :

```text
first_seen
last_seen
last_visited
content_hash
status
source_url
```

Pour ce que le site identifie lui-même (un id d'annonce), `ctx.items` tient cette
mémoire champ par champ : `observe(kind, key, champs)` dit `new` / `changed` /
`returned` / `unchanged` avec le diff, `markMissing(kind)` marque les disparus, et
`item_changes` garde l'historique — une série de prix est une requête. Voir
[`WORKFLOWS.md`](WORKFLOWS.md) §3.

Le système aval peut ensuite exploiter cette information pour produire des usages métier, par exemple :

* annonce disparue ;
* annonce modifiée ;
* baisse ou hausse de prix ;
* comparaison entre plusieurs portails ;
* historique d’évolution d’un même bien.

### Principe de découplage

```text
Snoopit
= navigation + collecte + état de crawl + provenance

Système aval
= indexation + mémoire sémantique + comparaison + raisonnement métier
```

Un workflow ne doit donc pas dépendre directement d’un moteur RAG, d’une base vectorielle ou d’une application métier spécifique.

---

## 9. Déploiement

```text
Ubuntu / OptiPlex
  systemd: snoopit-chrome.service   Chrome permanent, profil dédié,
                                    --remote-debugging-port lié à 127.0.0.1
  systemd: snoopit-scheduler.service  boucle du scheduler
  Chrome:  --headless=new (ou Xvfb si un rendu réel est nécessaire),
           --disable-dev-shm-usage
```

Docker reste optionnel et n'entre pas dans le MVP (§20 de la spec : « ne complexifie
pas prématurément le déploiement »). Le port de debug **n'est jamais** lié à `0.0.0.0` —
leçon directe du §4.8 de l'audit.

---

## 10. Stratégie de test

Le test est une contrainte d'architecture, pas une phase ultérieure. `FakeBackend`
(D3) et les fonctions pures (canonicalisation, budgets, fenêtres de planification,
sélection de frontier) permettent de couvrir la majorité du système **sans navigateur
et sans réseau**.

| Niveau | Cible | Navigateur |
|---|---|---|
| Unitaire | canonicalisation URL, fenêtres du scheduler, jitter, ordre de frontier, application des budgets, mapping d'extraction, escalade de recovery | non |
| Intégration | reprise de run, dédup, transitions d'état des pages, provenance d'artifact | non |
| E2E | découverte → navigation → extraction → téléchargement → persistance → rapport | oui, contre les fixtures locales |

**Aucun test ne dépend d'un site tiers** (§19 de la spec). Les fixtures HTML sont
servies localement et incluent délibérément un 404, une redirection, une bannière
cookies, une image manquante et un PDF téléchargeable.
