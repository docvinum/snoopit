# Exemple — collecter les « recherches enregistrées » d'un compte leboncoin

> Un exemple de bout en bout : les prérequis à réunir sur le déploiement, puis un
> prompt prêt à coller dans un coding agent (Claude Code, Codex) pour qu'il produise
> le workflow. La livraison attendue reste **un seul fichier dans `workflows/`**,
> aucune modification du runtime.

Cas d'usage de référence : « suivi d'annonces » (`docs/USE_CASES.md`). La cible
demande en plus une **session authentifiée**, ce qui déplace l'essentiel de l'effort
vers la préparation du profil Chrome.

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

La machine est headless (`--headless=new`), donc on se connecte **une fois**, par
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

### 1.3 Aucun identifiant dans le code ni la configuration

Le login est manuel et hors bande. Le workflow **assume** la session et se contente
de rapporter `authenticated: false` s'il rencontre le mur de connexion.

### 1.4 Anti-bot

leboncoin filtre agressivement (DataDome). Par conception, sur `403` ou CAPTCHA le
run se termine `blocked:*` avec un rapport — **c'est un constat, pas une panne**
(`docs/DEPLOYMENT.md` §6). Garder une cadence sobre (quotidien, fenêtre courte,
`maxPages` bas) : politesse, pas dissimulation.

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
sur 127.0.0.1:9222, `snoopit doctor` au vert). Le compte leboncoin est DÉJÀ connecté
dans le profil Chrome persistant — la session est fournie hors bande, tu n'as jamais
à te connecter.

Lis d'abord skills/snoopit/SKILL.md puis docs/WORKFLOWS.md. Ne touche pas à src/ :
la livraison attendue est UN SEUL fichier, workflows/leboncoin-recherches.ts.

Objectif : collecter périodiquement les « recherches enregistrées » du compte
leboncoin, et pour chacune relever les premières annonces des résultats, de façon à
détecter les nouveautés d'un run à l'autre.

── Étape 1 : exploration (ne code rien encore) ──
Avec Claude in Chrome, sur la session connectée, ouvre la page des recherches
enregistrées de leboncoin. Rapporte-moi :
  - l'URL exacte de cette page, et la forme de l'URL de résultats d'une recherche ;
  - le sélecteur de la liste, et par recherche : intitulé, critères résumés, lien
    vers les résultats, compteur éventuel de nouvelles annonces ;
  - bannière cookies / mur de connexion / challenge anti-bot présents, et à quoi on
    reconnaît qu'une session n'est plus valide.
Attends ma validation avant l'étape 2.

── Étape 2 : le workflow ──
Type `collect`. budget: { maxPages: 40, maxDuration: '15m', maxLlmCalls: 0 }.
Patron deux phases (découverte → collecte) du SKILL.

Phase 1 — découverte :
  - ctx.visit la page des recherches enregistrées, waitFor le sélecteur de liste,
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
- Un run `blocked:captcha` ou `blocked:*` se termine `completed` : le site a refusé
  l'accès, le run suivant retentera. On ne contourne pas.
- Si le rapport indique `authenticated: false`, la session a expiré — refaire
  l'étape 1.2.
