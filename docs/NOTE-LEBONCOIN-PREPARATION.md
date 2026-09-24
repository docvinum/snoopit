# Note technique — préparation de `snoopit` pour leboncoin

> Journal de la préparation opérationnelle faite sur `dell` (OptiPlex Ubuntu) pour
> doter le profil Chrome persistant d'une session leboncoin authentifiée, avant
> l'écriture du workflow `workflows/leboncoin-recherches.ts`. Le générique —
> prérequis et prompt du coding agent — reste dans
> [`EXEMPLE-LEBONCOIN.md`](EXEMPLE-LEBONCOIN.md).

État : préparation terminée, session validée, profil sauvegardé, workflow à créer.

---

## 1. Cible

| Élément | Valeur |
|---|---|
| Machine d'exécution | `dell` — OptiPlex, Ubuntu |
| Application | `/opt/snoopit` |
| Dépôt de travail | `~/snoopit` |
| Profil Chrome persistant | `/var/lib/snoopit/chrome-profile/` |
| CDP | `127.0.0.1:9222` (loopback strict) |
| Service navigateur | `snoopit-chrome.service` |
| Scheduler | `snoopit-tick.timer` |
| Base SQLite | `/var/lib/snoopit/data/snoopit.db` |
| Poste d'appoint | `beast` — Mac, Chrome graphique |

---

## 2. Déploiement vérifié

`snoopit doctor` au vert sur : liaison CDP loopback, Chrome 151 headless, base au
schéma v1, absence de runs périmés, workflows d'exemple détectés. Pas de clé LLM →
recovery limité à L0/L1 (accepté : le chemin nominal ne fait aucun appel).

> **Depuis** : le service ne tourne plus en `--headless=new` mais sous Xvfb — en
> headless, leboncoin répond 403 (DataDome). Configuration en vigueur :
> [`EXEMPLE-LEBONCOIN.md`](EXEMPLE-LEBONCOIN.md) §1.3 et
> `deploy/systemd/snoopit-chrome.service`. Ce qui suit est l'état du 2026-09-03.

Arguments notables du service Chrome (à cette date) :

```text
--headless=new
--no-sandbox                        # requis sous Ubuntu 24.04 / systemd (cf. DEPLOYMENT.md §7)
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--user-data-dir=/var/lib/snoopit/chrome-profile
```

---

## 3. Profil authentifié : création sur `beast`, transfert vers `dell`

`snoopit` ne se connecte jamais (SKILL règle 8, AGENTS règle 4). La session est
établie à la main, hors bande, puis déposée dans le profil.

**Sur `beast`** — Chrome graphique sur un profil jetable :

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/lbc \
  --no-first-run --no-default-browser-check \
  https://www.leboncoin.fr
```

Connexion au compte, validation de l'authentification, vérification de l'accès aux
recherches enregistrées, fermeture propre. Profil ≈ 195 Mo.

**Transfert** `beast` → `dell` :

```bash
rsync -av --progress /tmp/lbc/ optiplex:/tmp/lbc-profile/
```

**Installation sur `dell`** — service arrêté d'abord, profil courant sauvegardé
(par `deploy/backup-profile.sh`), puis remplacement :

```bash
sudo systemctl stop snoopit-chrome.service
sudo rm -rf /var/lib/snoopit/chrome-profile
sudo mv /tmp/lbc-profile /var/lib/snoopit/chrome-profile
sudo chown -R snoopit:snoopit /var/lib/snoopit/chrome-profile
sudo chmod 700 /var/lib/snoopit/chrome-profile
```

Le remplacement complet du profil écrase les autres sessions qu'il aurait pu
contenir. Ici le profil ne portait rien d'autre — sinon il aurait fallu se
connecter *dans* le profil existant (Xvfb + VNC) plutôt que le remplacer.

---

## 4. Portabilité macOS → Linux : validée

Un profil Chrome créé sous macOS n'est pas garanti lisible sous Linux — le
chiffrement des cookies dépend du trousseau de l'OS, et sans trousseau Chrome
retombe sur une clé de repli. Vérification par un Chrome graphique éphémère sur le
profil déposé :

- `Xvfb :99` ;
- `x11vnc` restreint à `localhost` ;
- tunnel SSH depuis `beast`, Screen Sharing macOS sur `vnc://localhost:5900`.

```bash
sudo -u snoopit env DISPLAY=:99 google-chrome-stable \
  --user-data-dir=/var/lib/snoopit/chrome-profile \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check \
  https://www.leboncoin.fr/account/searches
```

Résultat : session leboncoin active, recherches enregistrées accessibles.
(L'URL retenue ensuite pour le workflow est `/my-searches`, constatée dans le Chrome
sous Xvfb — cf. [`EXEMPLE-LEBONCOIN.md`](EXEMPLE-LEBONCOIN.md) §1.3.) La
portabilité est acquise **pour ce profil**, pas démontrée en général.

---

## 5. Sauvegarde du profil authentifié

Dans l'ordre : fermeture du Chrome graphique éphémère, arrêt du Chrome headless,
contrôle qu'aucun processus ne tient `chrome-profile`, puis :

```bash
cd ~/snoopit
sudo ./deploy/backup-profile.sh
```

Archive : `/var/lib/snoopit/backups/chrome-profile-2026-09-03T074109Z.tar.zst`
(≈ 91 Mo, caches exclus). Chrome de production relancé :

```bash
sudo systemctl start snoopit-chrome.service
```

---

## 6. Diagnostic final

```text
✓ cdp-binding    loopback (127.0.0.1)
✓ chrome         Chrome/151...
✓ database       schema v1
! jobs           0 job(s)
✓ stale-runs     none
✓ workflows      workflows d'exemple détectés
! llm            pas de clé, recovery limité à L1
```

`jobs 0` est normal à ce stade : aucun workflow leboncoin n'a encore tourné.

---

## 7. Décisions fonctionnelles pour `workflows/leboncoin-recherches.ts`

Périmètre :

- lire les recherches enregistrées du compte ;
- visiter leurs pages de résultats ;
- suivre chaque annonce par identifiant stable ;
- détecter : nouvelle annonce, annonce déjà connue, modification, variation de
  prix, disparition, réapparition — **suivi longitudinal complet**, état conservé
  par id d'annonce entre runs.

Champs relevés par annonce, au minimum : `id`, `titre`, `prix`, `date/heure`,
`url`, `localisation`, `urls des photos`, `nombre de photos`.

Contraintes fermes :

- aucun identifiant dans le code ni la configuration ;
- aucune tentative automatique de connexion ;
- aucun contournement de CAPTCHA / DataDome / 403 — le runtime arrête et rapporte ;
- aucun appel LLM sur le chemin nominal (`maxLlmCalls: 0`) ;
- pas d'import `playwright-core` ni de CDP direct dans le workflow ;
- SQLite reste la source de vérité.

Planification : `schedule_json` sur la ligne `jobs` en base (quotidien, fenêtre
matinale) — pas de cron système.

---

## 8. Prochaine étape

> **Fait le 2026-09-24** : exploration à partir des pages sauvegardées sur le Chrome
> connecté, workflow livré (`workflows/leboncoin-recherches.ts`). Constats et choix :
> [`EXEMPLE-LEBONCOIN.md`](EXEMPLE-LEBONCOIN.md) §1.3 et en-tête.

Exploration live du site par le coding agent, attaché au Chrome persistant via CDP,
sans toucher à `src/`. À identifier :

- structure de la page des recherches enregistrées et sélecteurs robustes ;
- structure d'une page de résultats, identifiant stable d'une annonce ;
- pagination vs. défilement infini ;
- données structurées disponibles (JSON-LD, `__NEXT_DATA__`, etc.) ;
- états cookies / mur de login / DataDome, et signes d'une session expirée ;
- stratégie de suivi longitudinal (diff par id contre l'artifact du run précédent).

Livraison attendue après validation de l'exploration : un seul fichier,
`workflows/leboncoin-recherches.ts`.
