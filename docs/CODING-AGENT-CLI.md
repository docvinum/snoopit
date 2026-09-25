# Piloter snoopit depuis un agent de coding

`snoopit` est l'exécutant déterministe ; l'agent de coding reste le pilote. Il
choisit un workflow, lance la CLI, lit les rapports structurés et décide de l'action
suivante. Snoopit ne contacte ni modèle ni API d'agent, et ne reçoit pas leurs clés.

Les exemples ci-dessous visent l'installation Dell. Toutes les commandes qui parlent
au runtime sont exécutées sous l'utilisateur `snoopit` et chargent le jeton de
l'extension depuis `/etc/snoopit/snoopit.env`.

```bash
snoopit() {
  sudo -u snoopit /bin/bash -c '
set -a
. /etc/snoopit/snoopit.env
set +a
exec node /opt/snoopit/dist/src/cli/main.js "$@"
' -- "$@"
}
```

Dans ce guide, `snoopit` désigne cette fonction de shell.

## Boucle opératoire

1. Vérifier l'environnement avant toute action navigateur :

   ```bash
   snoopit doctor --config /etc/snoopit/snoopit.config.yaml
   snoopit workflows --config /etc/snoopit/snoopit.config.yaml
   snoopit status --config /etc/snoopit/snoopit.config.yaml
   ```

2. Pour un essai contrôlé, lancer un seul workflow :

   ```bash
   snoopit run leboncoin-recherches --config /etc/snoopit/snoopit.config.yaml
   ```

   La sortie donne systématiquement l'identifiant du run et les chemins relatifs de
   `report.md` et `report.json`.

3. Lire d'abord le JSON, qui est l'interface machine stable :

   ```bash
   sudo -u snoopit sed -n '1,320p' \
     /var/lib/snoopit/data/jobs/leboncoin-recherches/runs/<run-id>/report.json
   ```

   Lire ensuite `report.md` lorsque l'agent doit produire une synthèse humaine. Les
   artifacts listés dans le rapport sont relatifs à `/var/lib/snoopit/data/`.

4. Décider à partir de `run.stopReason`, et non à partir de la seule sortie texte :

   | État | Action de l'agent |
   | --- | --- |
   | `done` | Exploiter `result`, les artifacts et les changements détectés. |
   | `budget:*` | Normal : laisser le prochain passage reprendre la frontier. |
   | `blocked:*` | Ne pas contourner le site. Demander une résolution humaine du CAPTCHA ou du refus. |
   | `auth-required` | Demander à une personne de se reconnecter dans le Chrome snoopit. |
   | `error` | Lire `error`, les problèmes et `events.jsonl`, puis corriger ou escalader. |

Le code de sortie de `run` est `0` pour un résultat terminé, `1` pour une erreur et
`3` pour un blocage ou une session expirée. Un agent doit traiter `3` comme une
demande d'action humaine, jamais comme une invitation à contourner une protection.

## Planification

Le timer systemd exécute `snoopit tick` toutes les dix minutes ; le scheduler choisit
les jobs réellement dus. Un agent contrôle la situation sans déclencher de visite :

```bash
snoopit due --config /etc/snoopit/snoopit.config.yaml
systemctl list-timers snoopit-tick.timer
journalctl -u snoopit-tick.service -n 100 --no-pager
```

Le planning est une propriété persistante du job, pas du fichier workflow. Sa
configuration et son changement sont décrits dans [DEPLOYMENT.md](DEPLOYMENT.md).

## Coupe-circuit Leboncoin

`leboncoin-recherches` active un coupe-circuit. Après `error`, `blocked:*`,
`auth-required`, ou une extension indisponible avant le run, le job est désactivé et
un événement `JOB_DISABLED` est enregistré. Le scheduler ne le relance plus.

Après intervention humaine, l'agent peut vérifier que le problème est résolu avec
`doctor`, puis demander la réactivation explicite à un opérateur. L'opérateur exécute
la commande fournie dans [DEPLOYMENT.md](DEPLOYMENT.md#réactiver-un-job-désactivé).

## Écrire ou modifier un workflow

Un agent crée normalement **un seul fichier** dans `workflows/`, puis exécute
`npm run check`. Il ne modifie pas le runtime pour un site particulier et n'importe
ni CDP ni Playwright depuis un workflow. La référence des primitives, budgets,
sélecteurs et tests est [WORKFLOWS.md](WORKFLOWS.md) ; le guide court d'agent est
[`skills/snoopit/SKILL.md`](../skills/snoopit/SKILL.md).
