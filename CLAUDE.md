# Gesnotes — backend

API de suivi scolaire multi-écoles (Express 5, Prisma 7, PostgreSQL). Le
frontend correspondant vit dans le dépôt voisin `../frontend` — deux dépôts
Git indépendants, pas un monorepo.

## Architecture en un coup d'œil

- **Isolation multi-écoles** : chaque table métier porte `school_id`.
  `schoolContext` (middleware) dérive `req.schoolId` uniquement du JWT décodé
  (`Authorization: Bearer <token>`) — plus aucune résolution par sous-domaine,
  en-tête ou nom d'hôte. La connexion se fait via `POST /auth/identify`
  (identifiant + mot de passe cherchés à travers toutes les écoles ;
  `schoolId` optionnel pour trancher un cas ambigu où le même
  identifiant/mot de passe correspond à plusieurs écoles). Toute nouvelle
  requête/service doit filtrer par `schoolId` explicitement, jamais par
  transitivité de relation.
- **Trois rôles** : `admin`, `teacher`, `parent` (`requireRole`). Un
  enseignant n'agit que sur ses `teacher_assignments` ; un admin n'est
  restreint que par son école.
- **Le pattern archiver → restaurer → supprimer définitivement** est établi
  pour `Class`, `Student`, `Term`, `SchoolYear` : `DELETE /:id` archive par
  défaut (`archived_at`), `?permanent=true&confirm_label=` supprime pour de
  bon et exige de retaper le libellé exact. Toute nouvelle entité supprimable
  doit suivre ce pattern plutôt qu'en inventer un — voir
  `src/services/term.service.ts` comme référence.
- **Notes/évaluations** : une note s'ancre à son `Evaluation` (classe, matière,
  période figées à la saisie), pas au `classId` courant de l'élève. Déplacer
  un élève ne corrompt jamais l'historique déjà noté.

## Conventions

- **Français partout** : commentaires de code, messages d'erreur,
  identifiants métier dans les commentaires. Les messages utilisateur doivent
  rester compréhensibles par un secrétariat d'école, pas seulement par un
  développeur — pas de jargon technique (`token`, `payload`, `rôle
  insuffisant`…), voir `tests/messages.test.ts` (`assertPlainFrench`) et
  `src/middlewares/validate.ts` (`FIELD_LABELS`).
- **Zod v4 + locale FR** (`src/lib/validationLocale.ts`, importé avant tout le
  reste dans `src/app.ts`).
- **Tests** : `vitest` + `supertest`. `tests/helpers.ts` fournit
  `resetDatabase`, `createSchool`, `createUser`, `seedGrade`,
  `seedEvaluation` — les réutiliser plutôt que recréer des fixtures.
  `resetDatabase()` supprime dans l'ordre des dépendances FK ; toute nouvelle
  table référencée doit s'y insérer au bon endroit. `globalSetup.ts` migre
  automatiquement une base `*_test` dédiée et refuse de tourner sur une base
  qui n'a pas "test" dans son nom.
- **Migrations** : fichiers SQL à la main dans `prisma/migrations/`, pas de
  `prisma migrate dev` à l'aveugle — suivre le style des migrations
  existantes (commentaire d'intention en tête, `RESTRICT` explicite quand une
  suppression ne doit pas se propager silencieusement).

## Git et livraison

- Une fonctionnalité = une branche dédiée créée depuis `origin/dev`, des
  commits au fil de l'eau, une PR ouverte contre `dev` (jamais `main`
  directement). Ne jamais laisser du travail non commité s'accumuler entre
  deux fonctionnalités.
- `main` et `dev` peuvent diverger — toujours `git fetch` puis vérifier l'état
  réel via `origin/*` et `gh pr list` avant d'affirmer qu'un travail est ou
  n'est pas livré.
- Pas de `Co-Authored-By` ni de mention d'outil IA dans les commits ou les PR.
- `npm run typecheck` et `npm test` avant d'ouvrir une PR — la suite complète
  tourne en ~3 min, ce n'est pas une raison de la sauter.

## Coordination et délégation

Ce fichier, pas un outil externe, est la référence : la coordination se fait
avec l'outil **Agent** de Claude Code, pas avec un système de délégation
tiers.

- **Déléguer à un sous-agent** (`Agent`, `subagent_type: Explore`) pour une
  recherche qui dépasse 2-3 `Grep`/`Read` ciblés, ou qui couvre plusieurs
  zones du code sans certitude sur l'emplacement. Pour une architecture ou un
  choix d'implémentation à trancher avant de coder, `subagent_type: Plan`.
- Le résultat d'un sous-agent est un brouillon, pas une vérité acquise : avant
  de le considérer comme fait, relire le diff produit, lancer `npm run
  typecheck` et les tests concernés — jamais faire confiance à un résumé
  d'agent sans vérifier le code réellement produit.
- Ne jamais faire transiter de secret dans un prompt de sous-agent — `.env`,
  jetons, mots de passe de test compris.
- Une seule anomalie observée une fois n'est pas une règle : ne l'ajouter à ce
  fichier (ou en mémoire) que si elle se répète ou que sa gravité le justifie.
  Un correctif ponctuel se répare dans le code, pas dans les instructions.

## Repères utiles

- `src/services/term.service.ts` / `src/services/schoolYear.service.ts` —
  référence du pattern archive/restauration/suppression définitive.
- `src/lib/csv.ts` — export/import CSV (BOM, `;`, virgule décimale FR, garde
  anti-injection de formule).
- `src/lib/events.ts` + `src/services/notification.service.ts` — bus
  d'événements interne (`grade.created`/`grade.updated`) déclenchant les push
  FCM ; étendre ce bus plutôt qu'appeler les notifications depuis un
  contrôleur.
