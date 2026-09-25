# Conventions — `snoopit`

> Établies au Lot 1. Destinées autant aux humains qu'aux coding agents (spec §18).

---

## 1. Outillage

| Outil | Rôle | Commande |
|---|---|---|
| TypeScript 5.7 (strict) | Typage | `npm run typecheck` |
| ESLint 9 (type-checked) | Lint | `npm run lint` |
| Prettier | Format du **code** | `npm run format` |
| Vitest 3 | Tests | `npm test` |
| `tsc` | Build | `npm run build` |

`npm run check` enchaîne format, lint, typecheck et tests — c'est exactement ce que
la CI exécute. **À lancer avant chaque commit.**

Le Markdown n'est pas formaté automatiquement : l'alignement de tableaux de Prettier
compte mal les caractères accentués et réécrit des documents sans bénéfice.

---

## 2. Règles TypeScript

Le `tsconfig.json` active davantage que `strict`, et chaque option supplémentaire
répond à une classe de bug observée dans l'audit :

| Option | Ce qu'elle empêche |
|---|---|
| `noUncheckedIndexedAccess` | `array[i]` supposé défini — le tableau vide silencieux |
| `exactOptionalPropertyTypes` | `undefined` confondu avec « absent » |
| `noUnusedLocals` / `noUnusedParameters` | Code mort qui survit aux refactors |
| `verbatimModuleSyntax` | Imports de types émis à l'exécution |

**Imports** : extension `.js` obligatoire dans les spécificateurs relatifs
(`import { x } from './y.js'`), y compris depuis un fichier `.ts`. C'est la règle
`NodeNext` ; TypeScript la résout vers `.ts` à la compilation, Vitest à l'exécution.

---

## 3. Frontières d'architecture

Trois règles non négociables, dérivées de `docs/ARCHITECTURE.md` :

1. **Seuls les repositories parlent SQL.** Aucun `db.prepare()` hors de
   `src/state/repositories/`. Le reste du code passe par un `Store`.
2. **Seuls les adaptateurs parlent CDP.** Aucun workflow, aucune règle métier
   n'importe `playwright-core` ni ne construit une commande CDP. Tout passe par
   `BrowserBackend`. Un seul fichier importe `playwright-core` :
   `src/runtime/browser/cdp.ts`.

   La lib TypeScript `DOM` est activée — `playwright-core` en a besoin, et le code
   évalué dans la page est du vrai code navigateur. Pour qu'elle ne fuie pas, une
   règle ESLint `no-restricted-globals` interdit `window`, `document`, `navigator`
   et `location` partout **sauf** dans `src/runtime/browser/{cdp,fake}.ts`.
3. **Aucun secret d'agent dans la configuration.** Les identifiants d'un agent ou
   d'un modèle appartiennent au processus externe qui appelle snoopit ; le runtime
   ne les lit jamais.

---

## 4. État et temps

- **Horodatages** : chaînes ISO-8601 UTC (`2026-08-31T08:00:00.000Z`). L'ordre
  lexicographique vaut ordre chronologique — tous les `ORDER BY` en dépendent.
- **Identité d'une page** : `(job_id, canonical_url)`. Jamais un numéro de page,
  jamais l'URL brute.
- **Migrations** : numérotées, contiguës, **immuables une fois appliquées**. Une
  migration déjà appliquée dont le SQL change fait échouer le démarrage
  (détection de dérive, risque R8). On corrige en avant, avec une nouvelle migration.
- **JSON en colonne** : un blob corrompu se lit `null` plutôt que de lever — une
  métadonnée illisible ne doit pas rendre un crawl entier inexploitable.

---

## 5. Tests

- `tests/unit/` — fonctions pures et modules isolés. Ni navigateur, ni réseau, ni disque.
- `tests/integration/` — plusieurs modules ensemble, sur SQLite `:memory:`.
- `tests/e2e/` — parcours complets contre les fixtures HTML locales (Lot 3).

**Conformité des backends** : `tests/integration/backend-conformance.test.ts` exécute
un seul jeu de tests contre `FakeBackend` **et** `CdpBackend`. Les deux reçoivent un
contenu identique au octet près, donc une divergence de résultat est une divergence
des *backends*, jamais des fixtures. La moitié Chrome se saute proprement — et
visiblement — quand aucun navigateur n'est joignable ; la CI l'exécute dans un job
dédié.

Une différence légitime entre les deux (le fake n'a ni horloge ni layout) est
**nommée dans un test dédié** (`tests/integration/cdp-only.test.ts`), jamais tolérée
en silence.

**Aucun test ne touche un site tiers** (spec §19). Un test qui exigerait un vrai
navigateur pour valider de la logique métier signale une fuite d'abstraction, pas un
besoin de navigateur.

Un test nomme le comportement attendu, pas la fonction appelée :
`'never resets an already-worked entry back to queued'` plutôt que `'test enqueue'`.

---

## 6. Commits

Un commit par lot cohérent : `type: sujet` (`feat:`, `fix:`, `docs:`, `test:`,
`chore:`). Le corps explique **pourquoi**, pas quoi — le diff dit déjà quoi.

---

## 7. Pièges connus

- **`.gitignore` vient d'un template Python.** Ses patrons de répertoires sont ancrés
  (`/build/`, `/lib/`) : non ancré, `downloads/` a avalé `src/runtime/downloads/`
  pendant cinq lots — tests verts en local, CI rouge, rien ne désignait la cause.
  `tests/unit/repo-hygiene.test.ts` échoue si cela recommence.
- **Le cache HTTP de Chrome est désactivé par défaut** sur les pages ouvertes par le
  runtime. Un crawler qui relit une page pour décider si elle a *changé* ne doit pas
  se faire servir sa propre copie. `Network.setCacheDisabled` exige
  `Network.enable` au préalable, sans quoi le réglage est accepté et ignoré.
- **`enqueue` ne ressuscite pas une entrée `done`** — c'est ce qui empêche un crawl
  de boucler. Une revisite passe par `requeue`, qui exprime l'intention inverse.

---

## 8. Signaux d'alerte

Repris de `docs/MVP.md` §5, à vérifier à chaque revue :

1. Un workflow importe du CDP ou de Playwright → l'abstraction a fui.
2. Le runtime appelle un LLM → la frontière avec l'agent externe est rompue.
3. Un test de logique métier exige un vrai navigateur → mauvais placement.
4. De l'état vit ailleurs que dans SQLite → D4 enfreint.
5. La reprise dépend d'un numéro de page → spec §8 enfreint.
