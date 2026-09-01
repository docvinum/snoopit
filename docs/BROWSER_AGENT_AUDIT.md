# Audit de `zxcHolmes/browser-agent` — et décision architecturale

- **Date de l'audit** : 2026-09-01
- **Cible auditée** : `https://github.com/zxcHolmes/browser-agent` @ `0f11ead`
- **Contexte** : Lot 0 du projet `snoopit` — orchestrateur de visites web persistantes utilisant Chrome comme moteur d'exécution.
- **Statut** : **décision arrêtée — option B (fork minimal / extraction conceptuelle)**

---

## 1. Synthèse exécutive

`browser-agent` est un **assistant de navigation piloté par LLM**, pas un moteur de crawl.
Il est propre, lisible et bien documenté pour ce qu'il fait — mais ce qu'il fait est
l'exact inverse de ce que `snoopit` doit faire.

Son idée différenciante est réelle et mérite d'être retenue : **piloter un Chrome
réel, déjà authentifié, sans le relancer avec `--remote-debugging-port`**, en passant
par l'API `chrome.debugger` d'une extension MV3.

Mais sur notre cible de déploiement (serveur Linux OptiPlex que nous contrôlons),
cette contrainte **n'existe pas** : nous pouvons lancer nous-mêmes un Chrome
persistant avec le port de debug ouvert. L'extension MV3 et le relais Go n'y
résolvent alors plus aucun problème, tout en important leurs coûts (cycle de vie du
service worker, état volatile, stack trilingue, surface réseau non authentifiée).

**Conclusion : nous ne forkons pas. Nous reprenons trois idées, aucune ligne de code,
et nous construisons `snoopit` en TypeScript sur un Chrome persistant piloté en CDP.**

---

## 2. Métriques du dépôt

| Indicateur | Valeur |
|---|---|
| Commits | 5 |
| Historique | une seule journée (2026-04-16) |
| Auteur | 1 (`zxcHolmes`) |
| Lignes (code + docs) | ~7 525 |
| Langages | Go, JavaScript, Python |
| **Tests** | **0** — aucun fichier de test, aucun harness, aucune CI |
| Licence | **Apache-2.0** |
| Gestion de dépendances | `go.mod` ; extension sans build ; CLI Python sans `requirements.txt` figé |

Un dépôt d'une journée, sans test ni CI, sans historique de maintenance : la
**maturité est celle d'un prototype de démonstration**, pas d'une base de production.

---

## 3. Architecture générale

Trois sous-systèmes, faiblement couplés entre eux mais tous subordonnés à la boucle LLM :

```text
App externe (REST)          Chat UI / chrome.alarms
        |                            |
        v                            v
  Proxy Go (:12345)            runner.js (boucle LLM)
  WebSocket hub                       |
  event store 3 min                   |
        |                             |
        +-------------> background.js (managedTabs: Map en mémoire)
                                      |
                              chrome.debugger (CDP)
                                      |
                                   Chrome
```

Le point d'entrée réel de la valeur est `chrome.debugger`. Tout le reste est
soit de la plomberie autour (relais Go), soit la boucle LLM (`runner.js`).

### Séparation extension / runtime

**Mal séparée.** Le proxy Go est présenté comme optionnel, mais l'extension est
non-optionnelle et concentre tout : registre d'onglets, exécution CDP, boucle LLM,
scheduler, historique, UI. `CLAUDE.md` l'assume explicitement :

> *« Tab Registry — single source of truth : `managedTabs: Map<tabId, tabInfo>` in
> `background.js` is the authoritative state. »*

C'est précisément l'anti-pattern que notre cahier des charges interdit
(« ne pas utiliser le navigateur lui-même comme source de vérité », « stockage
critique uniquement dans l'extension » à éviter).

---

## 4. Audit par composant

### 4.1 Extension Chrome / Manifest V3

`manifest.json` demande `debugger`, `tabs`, `activeTab`, `storage`, `alarms`,
`scripting` et `host_permissions: ["<all_urls>"]`. C'est le maximum de privilège
possible : lecture/écriture sur tout site, CDP brut sur tout onglet.

**Problème structurel — cycle de vie MV3.** Un service worker MV3 est terminé après
~30 s d'inactivité. Le dépôt lutte contre cela avec deux béquilles :

```js
keepAliveInterval = setInterval(() => {
  chrome.runtime.getPlatformInfo(() => {})           // hack de keepalive non documenté
  relayWs.send(JSON.stringify({ method: 'ping' }))   // trafic WS pour réarmer le timer
}, 20000)
```

Conséquences vérifiées dans le code :

- `managedTabs` est un `Map` en mémoire, **jamais persisté ni réhydraté**. Il n'y a
  aucun `chrome.runtime.onStartup`, et le bloc d'init ne restaure que les alarmes
  (`loadTabTimeout()` + `restoreAlarms()`).
- Si le worker cycle, le registre est perdu : les onglets ouverts deviennent
  orphelins, le `TabChecker` ne les connaît plus et **ne les fermera jamais** → fuite
  d'onglets sur un serveur qui tourne en continu.
- `activeRuns` est également en mémoire ; l'historique n'est écrit qu'**à la fin**
  d'un run. Un worker terminé en cours de run perd le run entièrement. **Aucune
  reprise n'est possible** — l'exigence n°1 de `snoopit`.
- `setInterval` (TabChecker, keepalive) ne survit pas à une terminaison.

**Verdict : inadapté à un service persistant.** Sur un serveur qui doit tourner des
semaines, ce modèle est le mauvais support pour l'état.

### 4.2 Accès Chrome DevTools Protocol

C'est la partie la plus saine. `attachDebugger` fait `chrome.debugger.attach(…, '1.3')`,
active `Page`/`Runtime`/`Network`, récupère le `targetId`. `toolCdp` transmet
`method`/`params` verbatim.

L'abstraction est **quasi inexistante et c'est volontaire** : le CDP brut est exposé
jusqu'au LLM (`cdp` est un outil du modèle) et jusqu'à l'API REST (`POST /api/cdp`).
Utile pour un agent exploratoire, inacceptable pour nous : notre cahier des charges
proscrit explicitement la « dépendance métier directe à Chrome CDP ».

### 4.3 Gestion des onglets

- Seuls les onglets créés via l'API sont gérés ; les onglets utilisateur sont invisibles.
- Timeout d'inactivité par défaut **1 minute** → fermeture automatique. Agressif et
  incompatible avec un crawl long où une page peut légitimement attendre.
- `toolCreateTab` fait un `await new Promise(r => setTimeout(r, 500))` en dur avant
  l'attach : **temporisation arbitraire**, symptomatique de l'absence de
  synchronisation déterministe.
- Pas de pool d'onglets, pas de limite de concurrence, pas de réutilisation.

### 4.4 Navigation

`toolNavigate` envoie `Page.navigate` puis attend via **polling de `document.readyState`
toutes les 300 ms** jusqu'à `'complete'`, avec un timeout qui **résout silencieusement**
au lieu de rejeter :

```js
if (Date.now() > deadline) { resolve(); return }   // échec silencieux
```

C'est doublement problématique : `readyState === 'complete'` ne signifie ni « contenu
rendu » ni « SPA prête », et un timeout indistinguable d'un succès rend toute logique
de crawl non fiable. Aucune gestion de redirection, de statut HTTP, de canonicalisation,
de `<link rel=canonical>`. Le proxy Go fait mieux (il attend `Page.loadEventFired` via
l'event store) mais ne remonte toujours aucun code HTTP.

**Le statut HTTP n'est nulle part exploitable** — or `http_status` et
`unexpected_redirect` sont des checks de premier niveau de notre workflow `audit`.

### 4.5 Exécution JavaScript

`toolEval` → `Runtime.evaluate` avec `returnByValue: true`. Correct, y compris la
remontée d'`exceptionDetails`. C'est le seul mécanisme d'extraction : **il n'existe
aucune API d'extraction structurée** (pas de sélecteurs, pas de mapping de champs,
pas d'accessibility tree). Le LLM écrit du JS ad hoc à chaque exécution — non
déterministe et non versionnable.

### 4.6 Screenshots

`Page.captureScreenshot` → data URL base64, injectée directement dans le contexte du
modèle. Fonctionnel, mais **jamais écrit sur disque** côté extension et compté à
512 tokens forfaitaires par image. Pas de full-page, pas de capture d'élément.

### 4.7 Téléchargements

> `grep -ri 'download'` sur l'ensemble du dépôt : **0 occurrence.**

**Fonctionnalité totalement absente.** Or le cas d'usage `collect` (récupérer les
nouvelles publications PDF et les ranger dans un répertoire) en dépend entièrement.
Ni `Page.setDownloadBehavior`, ni `Browser.setDownloadBehavior`, ni interception
réseau, ni écriture disque, ni hash de contenu, ni provenance.

### 4.8 REST bridge / API externe

Le proxy Go est la partie la mieux écrite : hub WebSocket propre, corrélation
requête/réponse par `id`, timeouts sur deux niveaux, enveloppe de réponse cohérente
(`{success, data}` / `{success, error, code}`), routage lisible.

**Mais la posture de sécurité est inacceptable en l'état :**

| Problème | Preuve | Impact |
|---|---|---|
| Aucune authentification | `grep -i 'auth\|token\|secret' *.go` → 0 occurrence | Toute requête est acceptée |
| Écoute sur **toutes** les interfaces | `Addr: fmt.Sprintf(":%d", cfg.Port)` | Exposé au réseau local, pas seulement `127.0.0.1` |
| Origine WebSocket non vérifiée | `CheckOrigin: func(r) bool { return true }` | Toute page web peut se connecter au relais |

Combiné à `POST /api/tabs/:id/eval` et `POST /api/cdp`, cela donne à quiconque sur le
réseau **l'exécution de JavaScript arbitraire dans un navigateur porteur des sessions
authentifiées de l'utilisateur**. Sur un serveur OptiPlex permanent, c'est
disqualifiant. Corrigeable (bind `127.0.0.1`, token partagé, `CheckOrigin` strict),
mais cela signale que la sécurité n'a pas été une préoccupation de conception.

Manquent également : pas de pagination, pas de rate limiting, pas de gestion
multi-clients (`RegisterClient` **ferme** la connexion précédente — un seul Chrome),
pas de file de commandes lors d'une déconnexion.

### 4.9 Intégration OpenRouter / OpenAI-compatible

`llm.js` est un client `chat/completions` minimal et honnête : `baseUrl` configurable,
trois providers pré-câblés (OpenRouter / OpenAI / Ollama) + « Custom ». Le couplage à
OpenRouter est faible — une seule condition spécifique :

```js
if (config.provider === 'openrouter') { body.reasoning = { effort: 'none', … } }
```

**Bon point réel** : `trimMessages` regroupe `assistant(tool_calls)` + ses messages
`tool` en **unités atomiques** avant d'élaguer, ce qui évite de casser l'appariement
tool_call/tool_result. C'est un détail correct que beaucoup d'implémentations ratent.

**Limites** : clé API en clair dans `chrome.storage.local` (lisible par toute
extension disposant de `storage` sur le même profil, et par quiconque a accès au
profil sur disque) ; aucune abstraction de provider (pas d'interface, pas
d'injection) ; pas de retry, pas de backoff, pas de gestion de rate limit ; pas de
comptabilisation de coût ; estimation de tokens à `chars/2` en dur.

### 4.10 Gestion des erreurs

Faible et incohérente.

- Erreurs d'outil converties en chaînes JSON renvoyées au modèle
  (`{ error: err.message }`) : le LLM devient le gestionnaire d'erreurs. Pas de
  typologie, pas de distinction récupérable / fatal.
- `catch {}` silencieux répandus (`Page.enable`, `Runtime.enable`, détection de prompt
  personnalisé, envoi de ping…).
- Timeout de navigation qui **résout** au lieu de rejeter (cf. 4.4).
- Aucune notion de retry, de backoff, ou de circuit breaker.
- Aucune détection de CAPTCHA / blocage / rate limiting — donc aucun arrêt propre
  possible, alors que notre spec l'exige (`STOP + journalisation + rapport`).

### 4.11 Dépendance au LLM

**Totale, et structurellement inversée par rapport à notre cible.**

`runner.js` *est* le produit : `MAX_ITERATIONS = 50` tours de
`chatCompletion → tool_calls → dispatch → chatCompletion`. Le README l'illustre
lui-même : 6 itérations LLM pour lire 5 titres sur Hacker News, dont un aller-retour
vision parce que le sélecteur a renvoyé `[]`.

C'est exactement le pattern que nous refusons :

```text
LLM -> click -> LLM -> click -> LLM
```

Il n'existe **aucun chemin d'exécution sans LLM**. Retirer le modèle ne dégrade pas
le système : il le supprime. Il n'y a donc rien à « rendre déterministe » — le
déterminisme devrait être ajouté depuis zéro, en dessous de tout l'existant.

### 4.12 Persistance et état

| Stockage | Support | Durée de vie |
|---|---|---|
| Registre d'onglets | `Map` en mémoire (service worker) | Jusqu'au cycle du worker |
| Runs actifs | `Map` en mémoire | `REPLAY_TTL_MS` = 2 min |
| Historique | `chrome.storage.local` | **24 h**, puis purgé |
| Événements CDP (Go) | tranche en mémoire | **3 min**, GC toutes les 30 s |
| Tâches planifiées | `chrome.storage.local` | Persistant |

**La durée de vie maximale de l'état utile est de 24 heures.** Aucune base de données,
aucune table d'URL, aucun `content_hash`, aucun `first_seen_at`, aucune frontier,
aucune déduplication, aucune canonicalisation. Un crawl incrémental est impossible —
et c'est notre exigence fondamentale (§7 de la spec).

### 4.13 Scheduler

`chrome.alarms` avec `delayInMinutes` = `periodInMinutes` = intervalle fixe.

Manquent : fenêtres temporelles, expressions cron, jitter/distribution de charge,
notion de « prochaine visite due », `pages_per_run`, verrouillage anti-recouvrement
(deux runs simultanés de la même tâche ne sont pas empêchés), reprise après
redémarrage en cours de run, budgets. La planification est **testable uniquement dans
Chrome**, ce qui contredit frontalement l'exigence « tests unitaires du scheduler ».

### 4.14 Tests

**Aucun.** Pas de test unitaire, pas de test d'intégration, pas de CI, pas de mock du
navigateur, pas de mock LLM, pas de fixtures HTML. Combiné à l'état en mémoire dans un
service worker et à la logique métier dans un LLM, le code est **structurellement
difficile à tester** : ce n'est pas un oubli à rattraper, c'est une conséquence de
l'architecture.

### 4.15 Maintenabilité

**Points positifs, à reconnaître honnêtement :**

- Code lisible, nommage clair, commentaires de section utiles.
- `CLAUDE.md` et `API.md` (594 lignes) sont sérieux et à jour.
- Le découpage du proxy Go (`config`/`events`/`handler`/`logger`/`relay`/`server`) est propre.
- Une compétence agent (`SKILL.md`) est déjà fournie — la même intention que notre §18.

**Points négatifs :**

- `background.js` : 742 lignes mêlant registre d'onglets, pont WebSocket, orchestration
  de runs et UI messaging.
- **Trois langages** (Go, JS, Python) pour ~7,5 kLOC — coût de maintenance
  disproportionné et duplication de la logique agent entre `runner.js` et `cli/agent.py`.
- Pas de TypeScript, pas de types, pas de linting, pas de build.
- Valeurs magiques en dur : `500`, `300`, `20000`, `50`, `128_000`, `CHARS_PER_TOKEN = 2`.

### 4.16 Licence et implications d'un fork

- **`browser-agent` : Apache-2.0.**
- **`snoopit` : MIT** (`Copyright (c) 2026 Alexandre Basta`).

Les deux licences sont permissives et **compatibles dans le sens Apache-2.0 → projet
MIT** : nous pourrions inclure ce code. Mais nous ne pourrions **pas le relicencier**
en MIT. Cela impliquerait :

1. conserver les en-têtes et la mention de copyright d'origine sur les fichiers repris ;
2. ajouter un fichier `NOTICE` et une attribution ;
3. signaler les modifications apportées (§4 de l'Apache-2.0) ;
4. hériter de la clause de brevets (avantage) et documenter un dépôt à double licence.

Le dépôt deviendrait à licence mixte, ce qui complique l'onboarding et la conformité
aval, **pour un gain de code très faible** (cf. §5). Les *idées* d'architecture ne sont
pas couvertes par le droit d'auteur : les réimplémenter proprement est à la fois
moins coûteux et juridiquement plus net.

> *Analyse d'ingénierie, pas un avis juridique.*

---

## 5. Couverture de nos exigences

| Exigence `snoopit` | État dans `browser-agent` |
|---|---|
| Navigation déterministe et scriptable | ❌ Absente — boucle LLM exclusive |
| Persistance de l'état entre runs | ❌ 24 h maximum, rien de structuré |
| Crawl incrémental / reprise | ❌ Absent |
| Frontier, dédup, canonicalisation URL | ❌ Absent |
| Planification (fenêtre, cron, jitter) | ⚠️ Intervalle fixe uniquement |
| Budgets de run | ⚠️ `maxToolCalls` / `MAX_ITERATIONS` seulement |
| Extraction structurée | ❌ `eval` de JS ad hoc |
| Téléchargements | ❌ **0 occurrence dans le dépôt** |
| Artifacts + provenance | ❌ Absent |
| Événements de domaine / observabilité | ⚠️ Événements CDP bruts, TTL 3 min |
| LLM en recovery ponctuel | ❌ **Inversé** — le LLM est le pilote |
| Profils navigateur / réseau | ❌ Absent |
| Détection blocage / CAPTCHA → STOP | ❌ Absent |
| Tests | ❌ Aucun |
| Workflows versionnés | ❌ Prompts en langage naturel dans `storage.local` |

**Une exigence sur quinze est partiellement couverte. Aucune ne l'est pleinement.**

---

## 6. Décision : **B — fork minimal / extraction**

> Nous **n'héritons d'aucun code**. Nous reprenons **trois idées de conception** et
> reconstruisons le produit autour.

### Pourquoi pas A (fork)

Le cahier des charges exige que la boucle LLM soit un **chemin d'exception**.
Dans `browser-agent`, c'est le **chemin unique**. Forker imposerait de supprimer
`runner.js`, `llm.js`, `chat.js`, `chat.html`, `cli/agent.py` (≈ 2 400 lignes, un
tiers du dépôt), de remplacer le stockage, la navigation, le scheduler et la gestion
d'erreurs — puis d'ajouter tout ce qui manque. Il resterait le pont CDP. **Ce n'est
plus un fork, c'est une réécriture portant une dette d'origine, une licence mixte et
un historique de 5 commits sans test.**

### Pourquoi pas C (réécriture ignorant l'upstream)

Ce serait jeter une intuition juste. `browser-agent` a correctement identifié que
**la valeur est dans un profil Chrome persistant et authentifié**, et que le CDP brut
doit rester accessible en dernier recours. Sa forme d'API REST et son découpage du
relais Go sont de bonnes références. Nous les gardons — comme références.

### Pourquoi B

C'est le seul choix qui capture la valeur (≈ 3 idées) sans la dette (≈ 7,5 kLOC,
0 test, licence mixte, MV3).

### Ce que nous conservons — idées, réimplémentées proprement

| # | Élément retenu | Forme dans `snoopit` |
|---|---|---|
| 1 | **Profil Chrome persistant et authentifié comme actif de premier ordre** | `--user-data-dir` dédié, monté et sauvegardé, sous `systemd` |
| 2 | **CDP brut accessible en échappatoire de dernier recours** | Méthode `page.cdp()` documentée, hors du chemin nominal |
| 3 | **Découpage d'API par verbes** (`navigate` / `eval` / `screenshot` / `tabs`) | Vocabulaire des primitives du Lot 2 |
| 4 | *(mineur)* Élagage de contexte par **unités atomiques** `assistant`+`tool` | Réutilisé dans le constructeur de contexte de recovery |

### Ce que nous remplaçons intégralement

| Composant upstream | Remplacement |
|---|---|
| Extension MV3 + service worker | **Supprimée du MVP** — Chrome persistant + CDP direct (cf. §7) |
| Relais Go + hub WebSocket | Supprimé — le runtime parle CDP directement |
| CLI Python | Supprimé — CLI TypeScript unique |
| `runner.js` (boucle LLM) | Workflows TypeScript déterministes ; LLM en fallback L2/L3 uniquement |
| `managedTabs` en mémoire | **SQLite** comme source de vérité |
| `chrome.storage.local` (24 h) | Tables `jobs` / `runs` / `crawl_pages` / `crawl_frontier` / `artifacts` / `events` |
| `chrome.alarms` (intervalle) | Scheduler à fenêtres temporelles, testable hors navigateur |
| Event store 3 min | `events.jsonl` durable + table `events` |
| `eval` de JS ad hoc | API d'extraction déclarative (sélecteurs → champs) |
| *(néant)* — téléchargements | Pipeline de téléchargement + hash + provenance |
| *(néant)* — tests | Vitest, mocks navigateur et LLM, fixtures HTML locales |

---

## 7. Conséquence majeure : nous n'avons pas besoin de l'extension

C'est le résultat le plus important de cet audit.

L'extension existe pour contourner **une seule contrainte** : *« Playwright/Puppeteer
exigent un Chrome lancé avec `--remote-debugging-port` »*. C'est vrai sur le poste de
travail d'un utilisateur, dont on ne veut pas relancer le navigateur.

**Sur l'OptiPlex, nous possédons la machine et le profil.** Nous lançons donc
nous-mêmes un Chrome permanent, avec un `--user-data-dir` dédié et le port de debug
ouvert sur `127.0.0.1`, supervisé par `systemd`. Le profil reste persistant, les
cookies et sessions survivent aux redémarrages — **le bénéfice de `browser-agent` est
conservé**, tandis que ses coûts disparaissent :

- plus de cycle de vie de service worker MV3 à combattre ;
- plus d'état critique dans le navigateur ;
- plus de relais Go, plus de langages Go et Python ;
- plus de surface HTTP non authentifiée sur le réseau ;
- accès à un écosystème CDP mature (attente d'événements, interception réseau,
  téléchargements, codes HTTP) au lieu d'un `readyState` en polling.

La contrainte de la spec (« une extension Chrome ne se comporte pas nécessairement
comme un service headless classique ») se résout donc **en retirant l'extension**,
et non en l'apprivoisant.

L'accès via extension reste un **adaptateur futur possible** derrière le port
`BrowserBackend` (cf. `docs/ARCHITECTURE.md`), utile si nous devions un jour piloter
le Chrome quotidien d'un poste de travail. Il n'entre pas dans le MVP.

---

## 8. Risques principaux

| # | Risque | Gravité | Mitigation |
|---|---|---|---|
| R1 | **Chrome persistant = état mutable non versionné** (profil corrompu, disque plein, cache) | Élevée | Profil dédié, sauvegarde/restauration scriptée, redémarrage périodique par `systemd`, SQLite hors profil |
| R2 | **Le déterminisme se dégrade** — les sites changent, les sélecteurs cassent | Élevée | Recovery en niveaux L0→L4, échec explicite plutôt que dérive, `CONTENT_CHANGED` observable |
| R3 | **Reprise partielle incorrecte** — pages sautées ou retraitées en boucle | Élevée | Frontier avec état explicite + URL canonique comme clé, tests de reprise dès le Lot 1 |
| R4 | **Glissement vers l'agent LLM** sous pression de cas difficiles | Moyenne | Budget `max_llm_calls` par run, recovery derrière une interface étroite, métrique « runs sans LLM » |
| R5 | **Blocage / CAPTCHA / rate limiting** | Moyenne | Détection → `STOP` + journalisation + rapport ; pas de contournement, par conception |
| R6 | **Chrome headless sur serveur** (rendu, polices, `/dev/shm`) | Moyenne | Xvfb ou `--headless=new`, `--disable-dev-shm-usage`, fixtures locales en CI |
| R7 | **Coût / latence / indisponibilité LLM** | Faible | Provider abstrait, budgets, fonctionnement nominal sans LLM |
| R8 | **Dérive de schéma SQLite** | Faible | Migrations numérotées dès le Lot 1 |
| R9 | **Surface de sécurité du port CDP** (leçon directe de l'audit) | Moyenne | Écoute strictement sur `127.0.0.1`, jamais `0.0.0.0` ; aucune API distante non authentifiée |

---

## 9. Hypothèses retenues

Documentées ici plutôt que soumises à confirmation, car réversibles :

1. **TypeScript / Node.js** pour l'ensemble du runtime — imposé par le format de
   workflow demandé (§4 de la spec) ; un seul langage contre trois en amont.
2. **SQLite** (`better-sqlite3`) comme source de vérité — accepté par la spec pour le MVP.
3. **Chrome persistant piloté en CDP**, pas d'extension dans le MVP (cf. §7).
4. **La couche CDP est isolée derrière un port `BrowserBackend`** — la spec interdit
   une dépendance métier directe au CDP ; le driver reste substituable.
5. **Aucun code Apache-2.0 n'est copié** — le dépôt reste MIT pur.
6. Le MVP vise **un seul Chrome, un run à la fois**. Pas d'architecture distribuée
   (§22 : « éviter l'architecture distribuée prématurée »).

---

## 10. Suites

- Architecture cible détaillée : **`docs/ARCHITECTURE.md`**
- Périmètre du MVP et séquence des lots : **`docs/MVP.md`**

Le Lot 1 (squelette, tooling, SQLite, modèles, tests initiaux) est débloqué par la
présente décision.
