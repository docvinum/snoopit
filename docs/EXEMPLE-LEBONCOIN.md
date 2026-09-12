# Exemple — collecter les « recherches enregistrées » d'un compte leboncoin

> Un exemple de bout en bout : les prérequis à réunir sur le déploiement, puis un
> prompt prêt à coller dans un coding agent (Claude Code, Codex) pour qu'il produise
> le workflow. La livraison attendue reste **un seul fichier dans `workflows/`**,
> aucune modification du runtime.

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
pas** — c'est la règle 8 de [`skills/snoopit/SKILL.md`](../skills/snoopit/SKILL.md)
et la règle 4 de [`AGENTS.md`](../AGENTS.md) (aucun contournement, aucune
automatisation d'identité). La session doit déjà exister dans
`/var/lib/snoopit/chrome-profile/`.

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

Le workflow **assume** la session (aucun identifiant dans le code ni la config) et
rapporte `authenticated: false` s'il atterrit sur `auth.leboncoin.fr`.

### 1.4 Protection anti-bot

leboncoin filtre agressivement (DataDome). Face à un **403**, CAPTCHA ou
interstitiel DataDome, le run s'arrête et le rapporte : **on ne contourne pas** la
protection, ni par rotation d'identité ni par autre moyen.

### 1.5 Clé LLM (optionnelle)

Sans `SNOOPIT_LLM_API_KEY` dans `/etc/snoopit/snoopit.env`, la recovery s'arrête à
L1 — suffisant pour une bannière ou une modale. Une clé L2 aide quand la structure
de la page bouge ; le chemin nominal reste à zéro appel.

### 1.6 Planification : pas de commande dédiée dans le MVP

`snoopit run <workflow>` crée un job **sans `schedule`** → `snoopit tick` ne le
reprend jamais. Pour du récurrent aujourd'hui : un `cron` système qui appelle
`snoopit run leboncoin-recherches`, ou écrire `schedule_json` sur la ligne `jobs` en
base. Un `schedule` first-class n'est pas encore exposé.

### 1.7 Build après ajout du workflow

Nouveau fichier `workflows/*.ts` → `npm run check`, `npm run build`, puis
`sudo ./deploy/install.sh` pour pousser le `dist/` mis à jour dans `/opt/snoopit`.

---

## 2. Prompt pour le coding agent

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
  - ctx.visit https://www.leboncoin.fr/my-searches, waitFor le sélecteur de liste,
    ctx.dismissOverlays.
  - Si l'état attendu n'est pas là, ctx.recover en garde (goal: accéder à la liste
    des recherches ; expectedState: le sélecteur de liste ; allowedActions:
    ['click','scroll','close_overlay']). S'il échoue → termine le run en renvoyant
    { authenticated: false, recherches: 0 } et écris un recherches.md qui le dit.
    NE TENTE JAMAIS de te connecter.
  - ctx.extract chaque recherche → ctx.frontier.discover(urlResultats,
    { kind: 'page', meta: { intitule, criteres } }).

Phase 2 — collecte :
  - Pour chaque URL de résultats prise dans ctx.frontier.take(...), ctx.visit,
    extraire les 20 premières annonces (id, titre, prix, date/heure de publication,
    URL, localisation). Sers-toi de visit.firstVisit / visit.changed comme signal.
    ctx.frontier.complete(entry). Une page illisible → ctx.frontier.fail, on continue.
  - ctx.artifacts.writeJson('recherches.json', ...) : par recherche, critères +
    annonces relevées.
  - ctx.artifacts.writeMarkdown('recherches.md', ...) : nb de recherches, et par
    recherche le nb de nouvelles annonces depuis le dernier run.

return {
  recherches,           // nb de recherches enregistrées vues
  verifiees,            // nb de pages de résultats réellement visitées CE run
  nouvelles, modifiees, // compteurs — verifiees compté à part (piège du SKILL)
  authenticated: true,
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
- Si le rapport indique `authenticated: false`, la session a expiré — refaire
  l'étape 1.2.
- Si chaque visite tombe sur un interstitiel DataDome (User-Agent `HeadlessChrome`
  dans `/json/version`), le Chrome tourne encore en `--headless=new` — reprendre
  l'étape 1.3.
