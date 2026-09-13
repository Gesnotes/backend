# backend

Backend de Gesnotes, plateforme numérique de suivi des notes scolaires
connectant enseignants, parents et administration.

API multi-écoles : saisie des notes par les enseignants, calcul automatique
des moyennes (élève, matière, classe), suivi de présence, génération de
bulletins PDF et notifications temps réel aux parents via Firebase Cloud
Messaging.

Le frontend correspondant vit dans le dépôt voisin `../frontend` — deux
dépôts Git indépendants, pas un monorepo.

**Rôles gérés :** Admin école, Enseignant, Parent

## Stack

- Express 5 + TypeScript
- Prisma 7 + PostgreSQL
- JWT (access + refresh token), mots de passe hachés avec Argon2
- Validation Zod v4, messages d'erreur en français
- Notifications push (Firebase Admin SDK)
- Emails via Resend (mode `console` par défaut en dev : rien n'est envoyé,
  le contenu s'affiche dans les logs)
- Bulletins PDF (pdfkit)
- Logs structurés (pino), suivi d'erreurs Sentry/GlitchTip
- Tests : Vitest + Supertest

## Prérequis

- Node.js 24
- PostgreSQL 16+

## Démarrage en local

```bash
npm install
cp .env.example .env       # au minimum : DATABASE_URL et JWT_SECRET
npm run prisma:migrate     # applique les migrations
npm run prisma:seed        # ou prisma:seed:demo pour un établissement complet
npm run dev                # http://localhost:3000
```

Comptes créés par les seeds et marche à suivre complète en local (connexion
sans sous-domaine, essai sur téléphone) : `../frontend/docs/DEV-LOCAL.md`.

## Scripts

| Commande | Rôle |
| --- | --- |
| `npm run dev` | serveur de développement (`tsx watch`) |
| `npm run build` / `npm start` | build TypeScript puis exécution du build |
| `npm run typecheck` | vérification des types sans build |
| `npm test` / `npm run test:watch` | suite Vitest |
| `npm run prisma:generate` | régénère le client Prisma |
| `npm run prisma:migrate` | applique les migrations en dev |
| `npm run prisma:studio` | interface d'administration de la base |
| `npm run prisma:seed` | jeu de données minimal (un compte par rôle) |
| `npm run prisma:seed:demo` | établissement complet de démonstration |
| `npm run prisma:seed:staff` | comptes du personnel (staff) |
| `npm run prisma:dedupe-subjects` | script ponctuel de nettoyage des matières dupliquées |

## Variables d'environnement

Voir `.env.example` pour la liste complète, commentée. Seules `DATABASE_URL`
et `JWT_SECRET` sont obligatoires pour démarrer ; le reste (emails,
notifications push, Sentry/GlitchTip) est facultatif et se dégrade
proprement (mode `console`, DSN vide = désactivé) tant qu'il n'est pas
renseigné.

Suivi des erreurs en local avec GlitchTip (auto-hébergé, compatible Sentry) :
`docker compose -f docker-compose.glitchtip.yml up -d`, marche à suivre dans
`docs/MONITORING.md`.

## Tests

```bash
npm test
```

Nécessite une base PostgreSQL dédiée dont le nom contient `test`
(`TEST_DATABASE_URL`, par défaut `gesnotes_test` — voir `vitest.config.mts`) ;
`tests/globalSetup.ts` la migre automatiquement et refuse de tourner sur une
base qui n'a pas « test » dans son nom, par sécurité. Suite complète en
~3 min — CI (`.github/workflows/ci.yml`) l'exécute sur chaque pull request.

## Architecture

Vue d'ensemble (isolation multi-écoles par JWT, trois rôles, pattern
archiver/restaurer/supprimer définitivement, modèle des notes/évaluations) :
voir `CLAUDE.md`.

## Déploiement

Image Docker (`Dockerfile`, Node 22 Alpine, build en deux étages) déployée
par `docker compose up -d --build backend` suivi de
`npx prisma migrate deploy`, sur push vers `main`
(`.github/workflows/deploy.yml`, déploiement par SSH vers le serveur).

## Git et livraison

Une fonctionnalité = une branche dédiée créée depuis `origin/dev`, PR ouverte
contre `dev` (jamais `main` directement). Le push direct sur `main`/`dev` est
bloqué localement par un hook (`.githooks/pre-push`, activé automatiquement
par `npm install` via le script `prepare`). `npm run typecheck && npm test`
avant d'ouvrir une PR.
