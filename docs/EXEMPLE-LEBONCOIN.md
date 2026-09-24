# Exemple — collecter les « recherches enregistrées » d'un compte leboncoin

> Un exemple de bout en bout : les prérequis à réunir sur le déploiement, puis un
> prompt prêt à coller dans un coding agent (Claude Code, Codex) pour qu'il produise
> le workflow. La livraison attendue reste **un seul fichier dans `workflows/`**,
> aucune modification du runtime.

> **Livré** : [`workflows/leboncoin-recherches.ts`](../workflows/leboncoin-recherches.ts),
> testé sur des fixtures anonymisées (`tests/fixtures/leboncoin/`). Il s'écarte du
> prompt du §2 sur trois points, décidés après lecture des vraies pages (§1.3) : il
> **clique** sur chaque recherche depuis `/my-searches` au lieu de charger ses
> résultats, il revoit les recherches **par lots** au fil de la journée (§1.6), et il
> détecte les **disparitions** quand une page montre toute la liste. Il a demandé une
> primitive runtime : `ctx.frontier.complete(entry, { revisitAfter })`.

Cas d'usage de référence : « suivi d'annonces » (`docs/USE_CASES.md`). La cible
demande une **session authentifiée** *et* un Chrome avec rendu réel (Xvfb) : avec
`--headless=new` le site ne se charge pas.

---

## 1. Prérequis

### 1.1 Déploiement opérationnel

`snoopit-chrome.service` actif, CDP sur `127.0.0.1:9222`, `snoopit doctor` au vert.
Voir [`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

### 1.2 Session leboncoin authentifiée dans le profil Chrome persistant

Les recherches enregistrées sont derrière le compte. `snoopit` **ne se connecte
pas** : la session est posée à la main dans le profil Chrome, et un workflow ne
contient jamais d'identifiant (règle 8 de
[`skills/snoopit/SKILL.md`](../skills/snoopit/SKILL.md), règle 3 d'
[`AGENTS.md`](../AGENTS.md) : aucun secret dans la configuration). La session doit
déjà exister dans `/var/lib/snoopit/chrome-profile/`.

Chrome tourne sans écran (Xvfb, §1.3), donc on se connecte **une fois**, par
l'un de :

- **Xvfb + VNC (recommandé)** — service arrêté, un vrai Chrome sur le même profil :

  ```bash
  sudo systemctl stop snoopit-chrome
  sudo -u snoopit xvfb-run -a google-chrome-stable \
    --user-data-dir=/var/lib/snoopit/chrome-profile https://www.leboncoin.fr
  # exposer ce display via x11vnc, se connecter (email + mot de passe + code e-mail), quitter
  sudo systemctl start snoopit-chrome
  ```

- **Copier un profil déjà connecté** depuis un poste de travail (`scp` du
  `--user-data-dir`, puis `chown -R snoopit:snoopit`). Plus rapide, mais sur Linux
  les cookies Chrome peuvent être chiffrés via le trousseau de session ; sans
  trousseau, Chrome utilise une clé de repli et le profil reste portable — à
  vérifier au premier run.

Une fois connecté : `sudo ./deploy/backup-profile.sh`. Le profil est la seule chose
que la base ne peut pas reconstruire.

> Fait sur `dell` le 2026-09-03 : profil créé sur un Mac, transféré par `rsync`,
> portabilité macOS → Linux contrôlée via un Chrome graphique éphémère, puis
> sauvegardé. Détail dans
> [`NOTE-LEBONCOIN-PREPARATION.md`](NOTE-LEBONCOIN-PREPARATION.md).

### 1.3 Parcourir le site : Chrome sous Xvfb

> **Alternative : le moteur extension.** Un Chrome visible sur la session de bureau
> de dell, sans port de débogage, où l'on se connecte à leboncoin à la main —
> [`DEPLOYMENT.md`](DEPLOYMENT.md) §9. Le workflow est inchangé : seul
> `browser.backend` change. Ce qui suit concerne le moteur CDP.

`--headless=new` s'annonce `HeadlessChrome` : une visite de `https://www.leboncoin.fr/`
répond **403** avec un interstitiel DataDome, page vide. Un Chrome « vrai » sous
Xvfb — même binaire, même profil, **sans** `--headless=new` — charge le site
(**200**, titre « leboncoin, site de petites annonces gratuites »). C'est le cas
prévu par [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) §7 (rendu complet), pas un
contournement.

Dans `snoopit-chrome.service`, le `ExecStart` devient :

```ini
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" \
  /usr/bin/google-chrome-stable \
  --no-sandbox \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir=/var/lib/snoopit/chrome-profile \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1920,1080 \
  about:blank
```

Puis `sudo systemctl daemon-reload && sudo systemctl restart snoopit-chrome`.
`snoopit doctor` doit rester au vert. Le User-Agent exposé par
`http://127.0.0.1:9222/json/version` doit dire `Chrome/…`, pas `HeadlessChrome/…`.

Carte des URLs (constatée dans ce Chrome) :

| Page | URL |
|---|---|
| Accueil | `https://www.leboncoin.fr/` |
| Mes recherches | `https://www.leboncoin.fr/my-searches` |
| Mur de connexion | redirection vers `https://auth.leboncoin.fr/login/?…&from_to=https://www.leboncoin.fr/my-searches` — h1 « Connectez-vous ou créez votre compte leboncoin ». C'est le signal d'une session absente ou expirée. |
| Résultats d'une recherche | `https://www.leboncoin.fr/recherche?…` — c'est ce que pointe une recherche enregistrée |
| Annonce | `https://www.leboncoin.fr/ad/<categorie>/<id>` |

Bannière cookies : Didomi (`#didomi-host`). `ctx.dismissOverlays` ; à défaut le
bouton « Continuer sans accepter » ou `#didomi-agree-to-all`.

Liste d'annonces : `article` contenant `[data-qa-id="aditem_container"]`, lien
`a[href^="/ad/"]` (titre, prix, localisation dans des `<p>` / `<span>` de la carte).

Structure relevée le 2026-09-24 sur le Chrome connecté (pages sauvegardées, puis
anonymisées en fixtures) :

- **`/my-searches`** : une carte par recherche, `article[aria-labelledby="name-<uuid>"]`.
  Le lien `a[title="Voir les résultats de recherche"]` couvre la carte ; il porte
  `saved_id_view=<uuid>` — l'identifiant stable de la recherche — et `sa=<date>`, qui
  change. Nom : `p[id^="name-"]` ; critères : le premier `p` sans attribut ; lieux :
  `p[aria-label]`.
- **Résultats** : barre `nav[aria-label="Filtrer les résultats de recherche"]` ;
  compteur dans un `h2` masqué « Résultats de recherche : 13 annonces ». Le prix,
  la ville et le terrain n'ont **aucun marqueur stable** ; ils sont lus dans les
  phrases d'accessibilité de la carte : « Prix: 339 000 €. », « Située à … »,
  « Surface du terrain N mètres carrés », « Baisse de prix ». Vendeur pro :
  `[data-qa-id="pro-store-name"]`, date relative dans l'`aria-label` du lien
  `/boutique/…` (« publiée mardi dernier à 12:22 »).
- Une annonce **remontée** apparaît deux fois : en tête sous une forme réduite
  (sans photos ni vendeur), puis à son rang.
- `__NEXT_DATA__` ne contient pas les annonces quand on arrive aux résultats par un
  clic (navigation côté client) : il reste celui de `/my-searches`.
- **Un chargement direct** d'une URL de résultats (`view-source:`) a reçu
  l'interstitiel DataDome (« Please enable JS and disable any ad blocker »,
  `ct.captcha-delivery.com/i.js`) alors que le clic depuis `/my-searches` passait.
  D'où la navigation par clic — le parcours normal de l'interface ; un challenge,
  s'il vient quand même, arrête le run.

Le workflow **assume** la session (aucun identifiant dans le code ni la config) et la
déclare : `ctx.visit(url, { session: { expectHost: 'www.leboncoin.fr' } })`. Une
redirection vers `auth.leboncoin.fr` arrête alors le run en `auth-required`
(événement `AUTH_REQUIRED`, code de sortie 3) au lieu d'enregistrer la page de
connexion comme contenu.

### 1.4 Protection anti-bot

leboncoin filtre agressivement (DataDome). Face à un **403**, CAPTCHA ou
interstitiel DataDome, `ctx.visit` arrête le run et le rapporte (`blocked:<raison>`,
code de sortie 3) : **on ne contourne pas** la protection, ni par rotation d'identité
ni par autre moyen.

### 1.5 Clé LLM (optionnelle)

Sans `SNOOPIT_LLM_API_KEY` dans `/etc/snoopit/snoopit.env`, la recovery s'arrête à
L1 — suffisant pour une bannière ou une modale. Une clé L2 aide quand la structure
de la page bouge ; le chemin nominal reste à zéro appel.

### 1.6 Planification : `schedule_json` sur la ligne `jobs`

`snoopit run <workflow>` crée le job **sans `schedule`** → `snoopit tick` ne le
reprend pas tant qu'on ne lui en donne pas un. Il n'y a pas encore de commande
dédiée ; on l'écrit en base après le premier run :

Pour `leboncoin-recherches` (47 recherches au relevé) : un run par heure entre 8 h
et 20 h, 4 à 5 recherches par run. Douze passages de quelques pages plutôt qu'un
seul de cinquante ; chaque recherche revient en file 20 h après sa revue, donc une
revue par jour environ.

```bash
sudo -u snoopit sqlite3 /var/lib/snoopit/data/snoopit.db "UPDATE jobs SET schedule_json =
  '{"frequency":"hourly","window":{"from":"08:00","to":"20:00"},"timeZone":"Europe/Paris","pagesPerRun":{"min":4,"max":5}}'
  WHERE id = 'leboncoin-recherches';"
node dist/src/cli/main.js due     # doit expliquer quand le job partira
```

Les runs manuels suivants (`snoopit run`) **conservent** ce planning. Sans
`timeZone`, la fenêtre se lit dans `scheduler.timeZone` de la configuration, à
défaut en UTC.

### 1.7 Build après ajout du workflow

Nouveau fichier `workflows/*.ts` → `npm run check`, `npm run build`, puis
`sudo ./deploy/install.sh` pour pousser le `dist/` mis à jour dans `/opt/snoopit`.

---

## 2. Prompt pour le coding agent

Le brief initial, conservé tel quel. Le workflow livré en diffère sur les points
signalés en tête de document.

```text
Contexte : le dépôt snoopit est déployé sur cette machine (Chrome persistant en CDP
sur 127.0.0.1:9222, sous Xvfb — pas --headless=new —, `snoopit doctor` au vert). Le
compte leboncoin est DÉJÀ connecté dans le profil Chrome persistant — la session
est fournie hors bande, tu n'as jamais à te connecter.

Lis d'abord skills/snoopit/SKILL.md puis docs/WORKFLOWS.md. Ne touche pas à src/ :
la livraison attendue est UN SEUL fichier, workflows/leboncoin-recherches.ts.

Objectif : collecter périodiquement les « recherches enregistrées » du compte
leboncoin, et pour chacune relever les premières annonces des résultats, de façon à
détecter les nouveautés d'un run à l'autre.

URLs et sélecteurs déjà constatés (docs/EXEMPLE-LEBONCOIN.md §1.3) :
  - recherches : https://www.leboncoin.fr/my-searches
  - résultats  : https://www.leboncoin.fr/recherche?…
  - annonce    : https://www.leboncoin.fr/ad/<categorie>/<id>
  - session expirée : redirection vers auth.leboncoin.fr/login (h1 « Connectez-vous
    ou créez votre compte leboncoin »)
  - cookies : Didomi #didomi-host ; ctx.dismissOverlays
  - cartes d'annonces : article [data-qa-id="aditem_container"], a[href^="/ad/"]

── Étape 1 : exploration (ne code rien encore) ──
Sur la session connectée, ouvre https://www.leboncoin.fr/my-searches. Rapporte-moi
le sélecteur de la liste des recherches, et par recherche : intitulé, critères
résumés, lien vers les résultats, compteur éventuel de nouvelles annonces.
Attends ma validation avant l'étape 2.

── Étape 2 : le workflow ──
Type `collect`. budget: { maxPages: 40, maxDuration: '15m', maxLlmCalls: 0 }.
Patron deux phases (découverte → collecte) du SKILL.

Phase 1 — découverte :
  - ctx.frontier.enqueueDueRevisits() en tout premier : sans cela, une page de
    résultats déjà traitée ne serait plus jamais revisitée.
  - ctx.visit https://www.leboncoin.fr/my-searches avec waitFor le sélecteur de
    liste et session: { expectHost: 'www.leboncoin.fr' }. Une session expirée
    arrête le run en auth-required : NE TENTE JAMAIS de te connecter, n'écris
    aucun code de repli pour ce cas.
  - ctx.dismissOverlays ; si la liste n'est toujours pas là, ctx.recover en garde
    (goal: accéder à la liste des recherches ; expectedState: le sélecteur de
    liste ; allowedActions: ['scroll','close_overlay']).
  - ctx.extract chaque recherche → ctx.frontier.discover(urlResultats,
    { kind: 'page', meta: { intitule, criteres } }).

Phase 2 — collecte :
  - Pour chaque URL de résultats prise dans ctx.frontier.take(...), ctx.visit avec
    revisitAfter: '20h' et la même option session, puis extraire les 20 premières
    annonces (id, titre, prix EN NOMBRE, date/heure de publication, URL,
    localisation, nombre de photos).
  - Pour chaque annonce : ctx.items.observe(`annonce:${idRecherche}`, id, champs).
    Son status ('new' | 'changed' | 'returned' | 'unchanged') et son diff
    (ex. { prix: { from: 250, to: 220 } }) sont LE signal. Ne compare jamais avec
    un JSON du run précédent : l'état est en SQLite.
  - N'appelle PAS ctx.items.markMissing : 20 premières annonces ≠ liste complète,
    une annonce sortie du top 20 n'a pas disparu.
  - ctx.frontier.complete(entry). Une page illisible → ctx.frontier.fail, on continue.
  - ctx.artifacts.writeJson('recherches.json', ...) : par recherche, critères +
    annonces relevées avec leur status.
  - ctx.artifacts.writeMarkdown('recherches.md', ...) : nb de recherches, et par
    recherche les nouvelles annonces et les baisses de prix.

return {
  recherches,           // nb de recherches enregistrées vues
  verifiees,            // nb de pages de résultats réellement visitées CE run
  nouvelles, modifiees, // compteurs issus de ctx.items — verifiees compté à part
}

Contraintes fermes :
  - aucun identifiant dans le code ni la config ;
  - maxLlmCalls: 0 sur le chemin nominal ;
  - face à un 403 / CAPTCHA / DataDome : laisse le runtime arrêter et rapporter,
    aucun contournement, aucune rotation d'identité ;
  - ferme toujours tes pages dans un finally ;
  - n'importe ni playwright-core ni du CDP dans le workflow.

── Fin ──
npm run check, puis npm run build && node dist/src/cli/main.js run leboncoin-recherches
contre le Chrome persistant. Montre-moi report.md et recherches.md.
```

---

## 3. Après le premier run

- Artifacts et rapports sous `/var/lib/snoopit/data/jobs/leboncoin-recherches/`.
- `sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js status` pour l'état du job
  (pages, frontier).
- Si le run s'arrête en `auth-required` (événement `AUTH_REQUIRED`, code de sortie
  3), la session a expiré — refaire l'étape 1.2.
- Chaque run écrit `recherches.md` (nouvelles 🆕, modifiées ✏️, disparues ❌, par
  recherche) et `recherches.json` dans son dossier d'artifacts.
- Historique des prix d'une annonce :

  ```bash
  sudo -u snoopit sqlite3 /var/lib/snoopit/data/snoopit.db "
    SELECT c.at, c.change, json_extract(c.diff_json, '$.prix.to')
      FROM item_changes c JOIN items i ON i.id = c.item_id
     WHERE i.kind = 'annonce' AND i.key = '<id annonce>' ORDER BY c.id;"
  ```

  Une annonce est suivie une fois (`kind: 'annonce'`, clé = id leboncoin), quelles
  que soient les recherches où elle figure ; sa présence dans chaque recherche l'est
  sous `recherche:<uuid>`, ce qui porte les disparitions.
- Une recherche supprimée du compte passe en échec (« recherche absente de
  /my-searches ») et n'est plus revue.
- Si chaque visite tombe sur un interstitiel DataDome (User-Agent `HeadlessChrome`
  dans `/json/version`), le Chrome tourne encore en `--headless=new` — reprendre
  l'étape 1.3.
