# Déploiement — `snoopit` sur l'OptiPlex

> Cible : Ubuntu, Chrome ou Chromium, systemd. Docker n'est pas nécessaire et
> n'entre pas dans le MVP (spec §20).

---

## 1. La forme du déploiement

```text
systemd
  snoopit-chrome.service    Chrome permanent, profil dédié, CDP sur 127.0.0.1:9222
  snoopit-tick.timer        réveille le scheduler toutes les 10 minutes
  snoopit-tick.service      un passage : lance les jobs dus, puis sort

/opt/snoopit                l'application (dist/, node_modules/)
/etc/snoopit                configuration et secrets
/var/lib/snoopit
  chrome-profile/           sessions authentifiées — la seule chose irremplaçable
  data/                     base SQLite, artifacts, rapports
```

Avec `browser.backend: extension`, le navigateur est un Chrome visible de la session
de bureau, piloté par l'extension snoopit, et `snoopit-chrome.service` est désactivé :
voir §9.

**Chrome tourne en permanence ; le scheduler non.** Le scheduler ne conserve aucun
état entre deux passages — ce qui est dû se déduit de la base et de l'horloge — donc
un processus qui démarre, travaille et sort n'a rien à perdre quand on le tue, et
rien à fuir quand il tourne des mois.

Le timer toutes les 10 minutes **n'est pas la fréquence de crawl** : un job quotidien
avec une fenêtre 08:00–10:00 ne tourne qu'une fois, à son propre instant jitté dans
cette fenêtre. Des réveils fréquents ne font qu'affiner la résolution.

---

## 2. Installation

```bash
git clone https://github.com/docvinum/snoopit.git
cd snoopit
sudo ./deploy/install.sh
```

Le script est **idempotent** : le relancer met à jour l'application sans jamais
toucher au profil Chrome ni à la base — les deux choses qui doivent survivre à un
déploiement. La configuration existante n'est jamais écrasée non plus : une mise à
jour ne doit pas changer silencieusement le comportement du crawler.

Vérification :

```bash
sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js doctor \
  --config /etc/snoopit/snoopit.config.yaml
```

---

## 3. Sécurité

**Le port de debug reste sur la boucle locale.** Il donne le contrôle complet d'un
navigateur porteur de sessions authentifiées — sans authentification d'aucune sorte.
C'est la leçon directe de l'audit : le projet amont exposait exactement cela sur
toutes les interfaces (`docs/BROWSER_AGENT_AUDIT.md` §4.8). `snoopit doctor` échoue
si la configuration pointe ailleurs que sur `127.0.0.1`.

**Les secrets ne sont pas dans la configuration.** `/etc/snoopit/snoopit.config.yaml`
nomme une variable d'environnement ; la valeur vit dans `/etc/snoopit/snoopit.env`,
en `0640`, lu par systemd via `EnvironmentFile`. Le fichier de configuration peut
donc être versionné et lu sans précaution.

Les unités tournent sous un utilisateur système dédié, avec `ProtectSystem=strict` et
`ReadWritePaths=/var/lib/snoopit` : le seul endroit inscriptible est l'état.

---

## 4. Sauvegarde du profil Chrome

Le profil porte les sessions authentifiées. C'est la seule chose que la base ne peut
pas reconstruire.

```bash
sudo ./deploy/backup-profile.sh              # vers /var/lib/snoopit/backups
sudo ./deploy/restore-profile.sh <archive>
```

**Chrome est arrêté pendant la copie.** Un instantané pris pendant que Chrome écrit
dans ses bases LevelDB peut se restaurer en profil corrompu — ce qui est pire que pas
de sauvegarde du tout : l'échec survient plus tard, silencieusement, et personne ne
le relie à la sauvegarde.

Les caches sont exclus (volumineux, changeants, reconstruits à la demande). Les sept
dernières sauvegardes sont conservées : une politique que personne ne purge remplit
le disque et emporte le crawler avec.

À la restauration, le profil courant est **déplacé, pas supprimé** — si l'archive
n'est pas la bonne, les sessions restent récupérables.

Automatisation possible via un timer systemd, ou :

```cron
0 3 * * * /opt/snoopit/deploy/backup-profile.sh >> /var/log/snoopit-backup.log 2>&1
```

Exemple concret — transfert d'un profil authentifié depuis un autre poste, contrôle
de portabilité macOS → Linux, puis sauvegarde :
[`NOTE-LEBONCOIN-PREPARATION.md`](NOTE-LEBONCOIN-PREPARATION.md).

---

## 5. Exploitation

```bash
systemctl status snoopit-chrome.service
systemctl list-timers snoopit-tick.timer
journalctl -u snoopit-tick.service -n 100

sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js due     # qui est dû, et sinon pourquoi
sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js status  # jobs, pages, frontier
```

Chaque run laisse une trace complète :

```text
/var/lib/snoopit/data/jobs/<job>/runs/<run-id>/
  report.md      report.json      events.jsonl
```

`events.jsonl` est écrit **au fil de l'eau** : même un run tué laisse une trace
lisible de sa progression.

**Fuseau horaire des planifications.** Les fenêtres (`08:00`–`10:00`) se lisent dans
le `timeZone` du planning du job, à défaut dans `scheduler.timeZone` de
`/etc/snoopit/snoopit.config.yaml`, à défaut en **UTC** — pas dans le fuseau de la
machine. Sur un serveur en France :

```yaml
scheduler:
  timeZone: Europe/Paris
```

`snoopit due` affiche la décision obtenue ; c'est la vérification à faire après tout
changement.

**Codes de sortie de `snoopit run`** : `0` terminé (arrêt sur budget compris), `1`
échec, `3` arrêt volontaire qui demande une action humaine — site qui refuse l'accès
(`blocked:*`) ou session expirée (`auth-required`, se reconnecter dans le profil
Chrome, §4). Un `tick` continue avec les jobs suivants quand l'un d'eux échoue.

---

## 6. Diagnostic

| Symptôme | Vérifier |
|---|---|
| Rien ne se passe | `due` — le job est peut-être hors de sa fenêtre, ou déjà passé cette période |
| « no CDP endpoint » | `systemctl status snoopit-chrome.service` |
| Un job semble bloqué | `doctor` — un run laissé `running` par un processus tué ; le run suivant le récupère |
| Run `blocked:captcha` | Le site refuse l'accès. C'est un constat, pas une panne : **on ne contourne pas** |
| Run `budget:max_pages` | Normal. Le run a fait ce qui lui était permis ; le suivant continue |

Un run `blocked:*` ou `budget:*` se termine `completed`, jamais `failed` : dans les
deux cas le système a fait exactement ce qu'on lui demandait.

---

## 7. Chrome sans affichage

`--headless=new` suffit pour la collecte et les screenshots. Si un site exige un
rendu complet (rare), remplacer par Xvfb :

```ini
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" \
  /usr/bin/google-chrome-stable --remote-debugging-address=127.0.0.1 …
```

`--disable-dev-shm-usage` est présent parce que `/dev/shm` est souvent trop petit sur
un serveur ; sans lui, Chrome meurt sur les pages lourdes.

`--no-sandbox` est présent parce que l'unit ferme les deux voies du sandbox interne
de Chrome : `NoNewPrivileges=true` neutralise le helper setuid `chrome-sandbox`, et
Ubuntu 24.04 bloque le sandbox par namespaces pour les processus non confinés
(`kernel.apparmor_restrict_unprivileged_userns=1`). Les deux fermées, Chrome avorte
au démarrage sur `sandbox/linux/services/credentials.cc`. Le confinement qui compte
ici est celui de l'unit — utilisateur `nologin` dédié, `ProtectSystem=strict`,
`ProtectHome=true`, `PrivateTmp=true` — et un port CDP qui ne quitte jamais la
boucle locale.

---

## 8. Mise à jour

```bash
cd /chemin/vers/snoopit && git pull
sudo ./deploy/install.sh
```

Les migrations sont appliquées par le script. Elles sont **immuables une fois
appliquées** : si une migration déjà passée a changé, le démarrage échoue plutôt que
de dériver en silence.

---

## 9. Moteur extension : un Chrome visible, sans port de débogage

`browser.backend: extension` remplace le Chrome sous Xvfb piloté en CDP par un
**Chrome dédié, affiché dans la session de bureau de dell**, que snoopit pilote par
son extension. Aucun port de débogage n'est ouvert ; on voit les visites se faire,
et on se connecte aux sites à la main, dans ce même Chrome.

```text
session de bureau (utilisateur de dell)
  Chrome snoopit              profil ~/.config/snoopit-chrome, extension snoopit
    └─ WebSocket ────────────► 127.0.0.1:9333, ouvert par snoopit le temps d'un run
systemd
  snoopit-tick.timer          inchangé : planning, frontier, SQLite, rapports
  snoopit-chrome.service      désactivé (utile seulement au moteur CDP)
```

Le reste ne change pas : mêmes workflows, même base, mêmes rapports. Le moteur CDP
reste disponible — `browser.backend: cdp` — et les deux passent la même suite de
conformité.

### 9.1 Mise en place

1. **Jeton d'appairage**, sur dell :

   ```bash
   openssl rand -hex 32        # à copier
   sudoedit /etc/snoopit/snoopit.env
   #   SNOOPIT_EXTENSION_TOKEN=<le jeton>
   ```

2. **Configuration** — `/etc/snoopit/snoopit.config.yaml` :

   ```yaml
   browser:
     backend: extension
     extension:
       port: 9333            # défaut
       connectTimeout: 45s   # défaut ; l'extension réessaie au moins toutes les 30 s
   ```

3. **Installer** : `sudo ./deploy/install.sh`. Il laisse `snoopit-chrome.service`
   désactivé et affiche le chemin de l'extension (`/opt/snoopit/dist/extension`).

4. **Le Chrome dédié**, dans la session de l'utilisateur de dell :

   ```bash
   cp deploy/desktop/snoopit-chrome.desktop ~/.config/autostart/
   cp deploy/desktop/snoopit-chrome.desktop ~/.local/share/applications/
   ```

   Puis le lancer (menu « Chrome snoopit », ou au prochain login). Il a son propre
   profil, séparé du Chrome de tous les jours.

5. **Charger l'extension**, une fois, dans ce Chrome : `chrome://extensions` →
   *Mode développeur* → *Charger l'extension non empaquetée* →
   `/opt/snoopit/dist/extension`. (Chrome ne permet plus de la charger par option de
   ligne de commande.)

6. **Appairer** : l'icône snoopit ouvre la page d'options ; y coller le jeton,
   *Enregistrer*. Le statut passe à « connectée à snoopit » au prochain run.

7. **Se connecter aux sites** (leboncoin…) dans ce Chrome, à la main. La session
   vit dans `~/.config/snoopit-chrome` ; snoopit ne se connecte jamais tout seul.

8. **Vérifier** :

   ```bash
   sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js doctor --config /etc/snoopit/snoopit.config.yaml
   sudo -u snoopit node /opt/snoopit/dist/src/cli/main.js run leboncoin-recherches --config /etc/snoopit/snoopit.config.yaml
   ```

   `doctor` vérifie le jeton ; le run ouvre une fenêtre dans le Chrome snoopit, y
   fait ses visites, puis la laisse vide.

### 9.2 Ce qu'il faut savoir

- **Chrome doit être ouvert**, et la session de bureau active : sans extension
  connectée, un run échoue au bout de `connectTimeout` avec « No snoopit extension
  connected… » et le tick suivant réessaie. Désactiver la mise en veille de dell.
  L'écran peut être verrouillé.
- **Les visites se font dans une fenêtre à part**, ouverte par l'extension ; ses
  onglets sont les seuls qu'elle touche. Fermer un de ces onglets pendant un run le
  fait échouer proprement.
- **Sécurité.** Le port 9333 n'écoute que sur `127.0.0.1`, et seulement pendant un
  run. L'appairage est une preuve HMAC **mutuelle** : ni snoopit ni l'extension
  n'envoient le jeton, et l'extension n'obéit à rien qui ne le prouve pas. Changer
  de jeton = le changer aux deux endroits.
- **Différences avec CDP**, sans effet sur les workflows : les clics sont des clics
  DOM (après le même contrôle d'interactabilité) ; une capture d'écran couvre la
  partie visible de la page, pas la page entière ; le cache HTTP est contourné par
  revalidation des pages (comme un rechargement) plutôt que désactivé.
- **Revenir au moteur CDP** : `backend: cdp`, puis
  `sudo systemctl enable --now snoopit-chrome.service`.
