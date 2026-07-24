# Plan d'implémentation — API Gesnotes (version finale)

Toutes les décisions structurantes sont arrêtées. Ce document est la référence d'exécution : il n'y a plus d'arbitrage à rendre avant de coder, sauf les deux points isolés au §8.

---

## 1. État réel du dépôt

À jour au moment de la rédaction, vérifié sur la branche `dev` :

| | État |
|---|---|
| Stack | Express 5 + Prisma 7 + PostgreSQL — **JavaScript CommonJS** |
| `tsconfig.json` | ❌ absent, aucun `.ts` versionné |
| Migrations | 2 appliquées : `init`, `add_subdomain_devices_grade_comment` |
| Schéma | 10 modèles — **aucun** des 12 changements du §3 n'est présent |
| Code métier | ❌ aucun : pas de `services/`, `middlewares/`, `routes/` |
| Base locale | vide (aucune donnée de test) |

> Le schéma cible (§3) et le code du §6 sont **à produire**. Rien de tout cela n'existe encore.
> Bonne nouvelle : la base étant vide, la migration passe sans script de backfill (cf. §3.3).

---

## 2. Décisions verrouillées

| Réf | Décision |
|---|---|
| 1.1 | **TypeScript** — à mettre en place (lot 0), avec bascule vers le générateur Prisma `prisma-client` |
| 1.2 | **Le JWT fait autorité** pour `school_id`. Le sous-domaine sert au routage pré-login et à la vérification de cohérence : `school.id !== payload.schoolId` → **403** |
| 1.3 | **`users.phone`**, `@@unique([schoolId, phone])` — unique par école, pas globalement |
| 1.4 | **Archivage par défaut** (`archived_at`), suppression physique en cascade sur `?permanent=true` (admin uniquement) |
| 2.1 | Moyenne matière en deux étapes : moyenne par catégorie, puis pondération `(M_interro + 2×M_devoir + 3×M_compo) / Σ poids` |
| 2.2 | Poids de note = **`GradeType.weight` uniquement**. `grades.coefficient` supprimée, `grade_type` libre remplacé par une FK |
| 2.4 | Coefficient matière : **deux couches** — `subject_coefficients[matière, classe]`, sinon `subjects.coefficient`, sinon 1. `classes.level` sert de gabarit, jamais de couche de calcul |
| 2.6 | Calculs en `Prisma.Decimal` de bout en bout, arrondi à 2 décimales **uniquement** à la sérialisation |

Hypothèses confirmées implicitement : poids `1/2/3` **configurables par école** (seedés, pas codés en dur) ; suppression permanente réservée au rôle `admin`.

---

## 3. Schéma cible — les 12 changements

### 3.1 Liste

| # | Changement |
|---|---|
| 1 | `User.phone` + `@@unique([schoolId, phone])` |
| 2 | `archivedAt DateTime?` sur `User`, `Class`, `Subject`, `Student` |
| 3 | `onDelete: Cascade` sur `Grade.studentId` et sur **les deux** relations de `StudentParent` |
| 4 | Table `RefreshToken` (`userId`, `tokenHash`, `expiresAt`, `revokedAt`) |
| 5 | Table `PasswordResetToken` (`userId`, `tokenHash`, `expiresAt`, `usedAt`) |
| 6 | Table `GradeType` (`code`, `label`, `weight`, `position`, `@@unique([schoolId, code])`) + `Grade.gradeTypeId` FK **obligatoire**, remplace `gradeType` |
| 7 | Table `SubjectCoefficient`, `@@id([subjectId, classId])` — doublon structurellement impossible |
| 8 | `Grade.coefficient` **supprimée** |
| 9 | `Class.level` |
| 10 | `Grade.schoolId` dénormalisé, FK directe vers `School` |
| 11 | `@@unique([teacherUserId, classId, subjectId])` sur `TeacherAssignment` |
| 12 | `schoolId` **NOT NULL** sur `User`, `Term`, `Class`, `Subject`, `Student`, `Grade` |

### 3.2 Deux ajouts nécessaires, absents de la liste

- **`Student.classId` doit aussi passer NOT NULL.** Il est aujourd'hui `Int?`. Le calcul des moyennes appelle `resolveSubjectCoefficient(subjectId, student.classId)` : avec un `classId` nullable, c'est une **erreur de compilation TypeScript**, et métier un élève sans classe n'a pas de coefficient résoluble donc pas de moyenne. À rendre obligatoire au même titre que `schoolId`.
- **Index sur `Grade`** : `@@index([studentId, termId])` et `@@index([schoolId, createdAt])`. Le premier porte tout le calcul des moyennes, le second le dashboard (lot 13). Les poser dans la même migration coûte zéro.

### 3.3 Procédure de migration

La base est vide → **aucun backfill nécessaire**, les colonnes `NOT NULL` et la FK `gradeTypeId` passent directement.

Deux options pour l'historique :

| Option | Quand | Effet |
|---|---|---|
| **Nouvelle migration** `schema_v2` *(recommandé)* | Les 2 migrations existantes sont déjà poussées sur `origin/main` | Historique linéaire, rien à réécrire |
| Reset + `init` unique | Seulement si on accepte de réécrire l'historique poussé | Historique plus propre, coût de coordination inutile ici |

⚠️ **`prisma migrate dev` est interactif** et échoue en environnement non interactif : la suppression de `grades.coefficient` et le remplacement de `grade_type` déclenchent un avertissement de perte de données. En local dans ton terminal, `npm run prisma:migrate` fonctionne normalement. En CI ou script, utiliser :

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o prisma/migrations/<timestamp>_schema_v2/migration.sql
npx prisma migrate deploy
```

Puis, dans la foulée : seed des 3 `GradeType` par école, `npx prisma generate`, et régénération de `gesnotes.sql`.

---

## 4. Modèle de notation — spécification de calcul

```
                    M_interro + 2 × M_devoir + 3 × M_composition
Moyenne matière  =  ───────────────────────────────────────────
                          Σ des poids des catégories NOTÉES

                     Σ ( coef_matière × Moyenne_matière )
Moyenne générale  =  ────────────────────────────────────
                       Σ ( coef_matière des matières notées )
```

### Cas limites — chacun exige un test unitaire dédié (lot 6)

| Cas | Règle |
|---|---|
| Catégorie absente (pas encore de composition) | Exclue du diviseur. `(M_interro + 2×M_devoir) / 3`, **jamais / 6** — c'est le piège principal : diviser par 6 afficherait un élève en échec au milieu du trimestre |
| Plusieurs devoirs ou compositions | Moyenne interne de la catégorie, puis pondération |
| `maxValue ≠ 20` | Normaliser avant tout calcul : `value / maxValue × 20` |
| Aucune note dans la matière | Matière exclue, **son coefficient sort aussi du dénominateur** |
| Aucune note du tout | `null`, jamais `0` |
| Élève archivé | Exclu des moyennes de classe et des classements |
| Note hors période | Filtrage strict sur `termId` |
| Doublon de saisie | Autorisé, mais **avertissement non bloquant** renvoyé au contrôleur |

---

## 5. Stratégie de branches

```
main          ← production, protégée, uniquement des merges de dev
 └── dev      ← intégration, protégée, uniquement des merges de PR
      ├── feat/xxx   ← une branche par lot du §7
      ├── fix/xxx
      └── chore/xxx
```

- Une branche = un lot = une PR = un merge **squash** dans `dev`. Jamais de commit direct sur `dev` ni `main`.
- Créer depuis `dev` à jour : `git checkout dev && git pull && git checkout -b feat/auth`.
- Rebase sur `dev` avant la PR, pas de merge-commit dans la branche de feature.
- `dev` → `main` par PR de release.
- **Migrations Prisma** : une seule branche à la fois touche au schéma. Après merge dans `dev`, les autres branches rebasent **et régénèrent** leur migration au lieu de la corriger à la main — deux migrations concurrentes produisent un historique divergent que `migrate deploy` refuse.

---

## 6. Code fourni — corrections requises avant intégration

Le service de calcul et le middleware de contexte école sont conformes à la spec métier (§4) : les cas limites sont traités un par un, le `Decimal` est conservé jusqu'à `serializeAverage`, le diviseur est bien la somme des poids réellement notés. **Cinq corrections sont nécessaires avant de les intégrer.**

### 6.1 Bloquant — le client Prisma ne démarrera pas

```ts
import { Prisma, PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
```

Deux problèmes :

1. **Prisma 7 exige un driver adapter.** `new PrismaClient()` sans `adapter` lève une erreur au démarrage. Le client est par ailleurs généré dans `src/generated/prisma`, pas dans `@prisma/client`.
2. **Un `PrismaClient` par module** ouvre un pool de connexions par fichier. En quelques services, la base sature.

→ Les deux fichiers doivent importer le **singleton partagé** (`src/lib/prisma`, qui encapsule `PrismaPg` — le `src/prisma.js` actuel en est la version JS) :

```ts
import { Prisma } from '../generated/prisma';
import prisma from '../lib/prisma';
```

### 6.2 Bloquant à l'échelle — N+1 sur les bulletins

`computeClassAverage` → `computeGeneralAverage` par élève → `computeSubjectAverage` + `resolveSubjectCoefficient` par matière.
Pour **40 élèves × 12 matières** : environ **1 000 requêtes SQL** pour un seul `GET /classes/:id`. Les routes concernées (`/classes/:id`, bulletin, dashboard) sont exactement celles qui doivent être rapides.

→ Garder ces fonctions comme référence unitaire (lisibles, testables sans base), mais ajouter un chemin batch pour les vues collectives :

```ts
// une requête pour toutes les notes de la classe, une pour tous les coefficients,
// puis calcul en mémoire avec les mêmes fonctions pures
export async function computeClassBulletin(classId: number, termId: number) {
  const [grades, coefficients, students] = await Promise.all([
    prisma.grade.findMany({
      where: { termId, student: { classId, archivedAt: null } },
      include: { gradeType: true },
    }),
    prisma.subjectCoefficient.findMany({ where: { classId } }),
    prisma.student.findMany({ where: { classId, archivedAt: null } }),
  ]);
  // → regrouper par élève/matière/type et réutiliser la logique pure de §6.5
}
```

**Prérequis** : extraire le calcul pur (`Grade[] → Decimal | null`) des accès base. C'est aussi ce qui rend les tests du §4 exécutables sans base de données.

### 6.3 Erreur de compilation — `student.classId` nullable

`resolveSubjectCoefficient(subject.id, student.classId)` ne compile pas tant que `Student.classId` est `Int?`. Corrigé par le §3.2.

### 6.4 Sécurité — `schoolContext` n'est pas un garde d'authentification

Sans en-tête `Authorization`, le middleware fait `req.schoolId = school.id; return next();`. C'est **le bon comportement** (la page de login en a besoin), mais cela signifie qu'une requête **sans token traverse ce middleware avec succès**.

→ Toute route métier doit être protégée par un **`requireAuth` distinct**, placé après. Monter `schoolContext` globalement et croire que les routes sont protégées est le scénario où toute l'API devient publique. À écrire noir sur blanc dans le lot 2, et à couvrir par un test « requête sans token sur une route métier → 401 ».

### 6.5 Ergonomie de développement — sous-domaine en local

`req.hostname.split('.')[0]` renvoie `localhost` en développement : aucune école ne correspond, **toutes les routes répondent 404**. Prévoir dès le lot 2 un repli (en-tête `X-School-Subdomain` ou `DEFAULT_SCHOOL_SUBDOMAIN`), actif uniquement hors production.

### 6.6 Points mineurs, à trancher au fil de l'eau

- `computeGeneralAverage` parcourt **toutes** les matières de l'école ; mieux vaut ne parcourir que celles enseignées dans la classe de l'élève (via `subject_coefficients` / `teacher_assignments`).
- `checkDuplicateWarning` se base sur `createdAt` (date de **saisie**). Si une note porte une date d'évaluation propre, c'est elle qu'il faut comparer.
- Un utilisateur archivé conserve l'accès jusqu'à l'expiration de son access token (15 min). Acceptable ; à documenter, ou à durcir via une vérification en base sur les routes sensibles.

---

## 7. Lots d'implémentation

### Phase 0 — Fondations

| Lot | Branche | Dépend de | Contenu | Sortie |
|---|---|---|---|---|
| **0** | `chore/typescript` | — | `tsconfig.json` strict, `.js` → `.ts`, build `tsc`, `tsx watch`, bascule du générateur Prisma vers `prisma-client` | `npm run build` passe, `/health` répond |
| **1** | `feat/db-schema-v2` | 0 | Les 12 changements du §3.1 + les 2 ajouts du §3.2, en **une** migration. Seed : 1 école, 1 admin, 3 `GradeType` | `migrate status` à jour, `gesnotes.sql` régénéré |
| **2** | `feat/core-http` | 1 | `routes/ → controllers/ → services/` (jamais de Prisma dans un contrôleur) · `schoolContext` (§1.2) **+ `requireAuth` distinct (§6.4)** · `requireRole` · `AppError` + format `{ error: { code, message, details } }` + mapping Prisma (`P2002`→409, `P2025`→404) · validation Zod · `helmet`, `cors`, rate-limit `/auth/*`, `pino` · repli sous-domaine local (§6.5) | Route de test : **401 sans token**, 403 mauvais rôle, 403 sous-domaine incohérent, 200 sinon |
| **3** | `feat/auth` | 2 | `login` (email **ou** téléphone) · `logout` · `forgot-password` · `reset-password` · `argon2`, access 15 min + refresh en base avec rotation · **rejet des comptes `archivedAt != null` dans le service d'auth**, pas dans le middleware (§8.1) · réponse identique que le compte existe ou non · `MailerService` derrière une interface | login → appel protégé → logout → refresh invalide. Tests : mauvais mot de passe, compte archivé, token expiré |

> **Jalon 1** — au-delà, les lots sont parallélisables.

### Phase 1 — Administration

| Lot | Branche | Dépend de | Contenu | Sortie |
|---|---|---|---|---|
| **4** | `feat/admin-subjects` | 3 | CRUD `/subjects` + gestion des `subject_coefficients` par classe. `DELETE` = archivage | Coefficient par classe testé **avec** son fallback école |
| **5** | `feat/admin-teachers` | 3 | CRUD `/teachers`, création `users` + `teacher_assignments` en transaction, `DELETE` = archivage | Création avec 3 classes en un appel ; archivage sans perte de note |
| **6** ⭐ | `feat/grading-core` | 3 | Le §4 en code. Aucun endpoint. Logique **pure** séparée des accès base (§6.2), plus le chemin batch `computeClassBulletin` | Un test unitaire **par ligne** du tableau §4, sans base, + un jeu réel recalculé à la main |
| **7** | `feat/admin-classes` | 5, 6 | CRUD `/classes` (avec `level`), `GET /classes/:id` classé par moyenne, copie des coefficients depuis une classe du même niveau | Classement correct, élèves archivés exclus |
| **8** | `feat/admin-students` | 7 | CRUD `/students` (archivage, `?permanent=true` admin) · `/parents/search` · association/dissociation parent · création parent par **invitation** (jamais de mot de passe en clair dans le payload) | Recherche testée sur nom/email/**téléphone** ; suppression permanente vérifiée en cascade |

### Phase 2 — Enseignant et parent

| Lot | Branche | Dépend de | Contenu | Sortie |
|---|---|---|---|---|
| **9** ⭐ | `feat/teacher-grades` | 6, 8 | `/teachers/me/classes`, `/teachers/me/grades`, CRUD `/grades`, historique · **`assertCanGrade(user, classId, subjectId)` : une seule fonction** appelée par les 5 routes · saisie par `gradeTypeId`, `0 ≤ value ≤ maxValue` · `checkDuplicateWarning` non bloquant · émet `grade.created` / `grade.updated` | **Prof A écrit sur la classe du prof B → 403.** Le test le plus important du projet |
| **10** | `feat/parent-space` | 6, 8 | `/parents/me/children`, `/children/:id`, `/children/:id/grades`, `/grades/:id` · `assertIsParentOf(user, studentId)` sur les 4 routes · `/grades/:id` accessible parent **et** prof → deux règles explicites | Parent A demande l'enfant du parent B → **404** (pas 403 : ne pas divulguer l'existence de l'élève) |
| **11** | `feat/push-notifications` | 9 | `POST`/`DELETE /parents/me/devices` · consomme les événements du lot 9 → FCM · envoi **hors du cycle requête/réponse** · purge des tokens invalidés | FCM en panne → la note est **quand même** enregistrée |

### Phase 3 — Restitution

| Lot | Branche | Dépend de | Contenu | Sortie |
|---|---|---|---|---|
| **12** | `feat/bulletin-pdf` | 6, 7 | `/classes/:id/bulletin` (JSON d'abord) puis `/export` (PDFKit). Affiche le détail par catégorie **et** le coefficient appliqué : c'est la pièce que les parents contestent, elle doit être auditable | Moyennes du PDF identiques à celles de `GET /classes/:id` |
| **13** | `feat/admin-dashboard` | 6, 9 | `/admin/dashboard`, `/recent-grades`. S'appuie sur les index du §3.2 | Chiffres cohérents avec le seed, < 300 ms |

---

## 8. Les deux seuls points encore ouverts

### 8.1 Rejet des comptes archivés au login — **tranché : dans le service d'auth**

Le middleware `schoolContext` s'exécute **après** émission du token : trop tard, et ce n'est pas son rôle. La vérification `archivedAt != null` appartient au service d'authentification, au même endroit que la vérification du mot de passe, avec un message d'erreur **indifférencié** (ne pas révéler qu'un compte existe mais est désactivé).
Second point à ne pas oublier : à l'archivage d'un utilisateur, **révoquer ses refresh tokens** (`revokedAt = now()`), sinon il se re-connecte indéfiniment sans repasser par le login.

### 8.2 Portée de la vérification d'archivage sur les tokens en cours

Un utilisateur archivé garde l'accès jusqu'à expiration de son access token (15 min). Deux options : l'accepter (simple, fenêtre courte) ou vérifier `archivedAt` en base à chaque requête (coût : une requête par appel). **Recommandé : l'accepter**, et ne durcir que si un besoin réglementaire l'exige.

---

## 9. Conventions

```
src/
├── middlewares/     schoolContext, requireAuth, requireRole, validate, errorHandler
├── routes/          déclaration + validation, aucune logique
├── controllers/     HTTP uniquement
├── services/        logique métier, seul endroit qui parle à Prisma
├── lib/             prisma (singleton + adapter), mailer, fcm, jwt
└── errors/          AppError et dérivés
```

**Tests** — un lot sans tests n'est pas terminé.
Unitaires sur le calcul (lot 6, priorité absolue). Intégration (Supertest + base dédiée) sur chaque endpoint avec **quatre** cas : nominal, non authentifié, mauvais rôle, **ressource d'une autre école**. Le quatrième est non négociable, c'est la promesse d'isolation multi-écoles.

**Sécurité** — aucune route ne renvoie `password_hash` (sélection explicite des champs, jamais un objet Prisma brut) · filtrage par `school_id` sur **toute** requête, `findUnique` par id compris · rate-limit sur `/auth/login` et `/auth/forgot-password` · secrets en variables d'environnement (`.env` déjà ignoré par git).

---

## 10. Ordre d'exécution

```
0 typescript → 1 db-schema-v2 → 2 core-http → 3 auth ─┬→ 4 subjects
                                                      ├→ 5 teachers → 7 classes → 8 students ─┬→ 9 teacher-grades → 11 push
                                                      └→ 6 grading-core ──────────────────────┴→ 10 parent-space
                                                                                               └→ 12 bulletin → 13 dashboard
```

**Chemin critique** : 1 → 2 → 3 → 6 → 9.
Lots 4, 5 et 12 parallélisables après le jalon 1.
**Seul** : l'ordre linéaire 0 → 13, chaque lot restant testable de bout en bout.
