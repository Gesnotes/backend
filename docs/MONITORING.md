# Suivi des erreurs — GlitchTip

GlitchTip est une alternative libre et auto-hébergée à Sentry. Il **parle le
protocole Sentry** : les SDK officiels `@sentry/node` et `@sentry/react`
fonctionnent tels quels, seul le DSN change. Si vous passez un jour à Sentry
hébergé, il n'y a pas une ligne de code à modifier.

Sans DSN, tout est **désactivé** : l'application se comporte exactement comme
avant, aucun appel réseau, aucun surcoût.

## 1. Démarrer GlitchTip en local

```bash
cd backend
docker compose -f docker-compose.glitchtip.yml up -d
```

Quatre conteneurs : Postgres, Redis, l'interface web, et un *worker* qui ingère
les événements. **Le worker est indispensable** — sans lui les erreurs sont
reçues mais jamais traitées, et l'interface reste vide.

Le premier démarrage prend une minute (migrations). Suivre l'avancement :

```bash
docker compose -f docker-compose.glitchtip.yml logs -f glitchtip-web
```

## 2. Créer le projet

1. Ouvrir <http://localhost:8000>.
2. **Register** — le premier compte créé est administrateur.
3. Créer une organisation (ex. `Gesnotes`).
4. Créer **deux projets** : `gesnotes-backend` (plateforme *Node.js*) et
   `gesnotes-frontend` (plateforme *React*).
5. Chaque projet affiche son **DSN**, de la forme :

```
http://a1b2c3d4e5f6@localhost:8000/1
```

## 3. Renseigner les DSN

**`backend/.env`**

```dotenv
SENTRY_DSN=http://<clé-du-projet-backend>@localhost:8000/1
SENTRY_ENVIRONMENT=development
SENTRY_TRACES_SAMPLE_RATE=0
```

**`frontend/.env.local`**

```dotenv
VITE_SENTRY_DSN=http://<clé-du-projet-frontend>@localhost:8000/2
VITE_SENTRY_ENVIRONMENT=development
```

Redémarrer les deux serveurs — Vite ne relit `.env.local` qu'au démarrage.

## 4. Vérifier que ça marche

**Backend** — une route de test existe en développement :

```bash
curl http://localhost:3000/debug/erreur-test
```

Elle répond `500` et l'erreur doit apparaître dans GlitchTip en quelques
secondes. Cette route n'existe ni en production ni en test.

**Frontend** — dans la console du navigateur :

```js
window.__gesnotesTestError?.()
```

## Ce qui est envoyé, et ce qui ne l'est pas

Ce produit manipule les notes d'élèves mineurs. La configuration est délibérément
sobre :

| Envoyé | Jamais envoyé |
|---|---|
| Message et pile d'appel | Nom, prénom, email |
| Méthode HTTP et chemin (sans query string) | Corps de requête, cookies, en-têtes |
| Identifiant utilisateur, rôle, école | Adresse IP (`sendDefaultPii: false`) |
| Version et environnement | Notes, moyennes, commentaires |

`beforeSend` supprime `request.data`, `request.cookies` et `request.headers`
avant tout envoi, même si une intégration future venait à les capturer.

**Seules les erreurs `5xx` sont remontées.** Un `404`, un `409` ou un `401`
sont des réponses métier normales — élève introuvable, doublon refusé, mot de
passe erroné. Les envoyer noierait les vraies anomalies sous des milliers
d'événements attendus.

## Passage en production

À faire le moment venu :

1. **`SECRET_KEY`** aléatoire dans le compose :
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. **Mot de passe Postgres** autre que `glitchtip`.
3. **Fermer les inscriptions** : `ENABLE_USER_REGISTRATION: 'false'` une fois
   votre compte créé, sinon n'importe qui s'inscrit sur votre instance.
4. **HTTPS** devant, et `GLITCHTIP_DOMAIN` sur l'URL publique.
5. **SMTP** réel pour les alertes par email (sinon elles restent dans les logs).
6. **Sauvegarder** le volume Postgres.
7. Mettre les DSN de production dans les `.env` du serveur, avec
   `SENTRY_ENVIRONMENT=production`.

La rétention est fixée à 30 jours (`GLITCHTIP_MAX_EVENT_LIFE_DAYS`) : sans
purge, la base grossit indéfiniment.

## Arrêter / réinitialiser

```bash
docker compose -f docker-compose.glitchtip.yml down        # arrêt
docker compose -f docker-compose.glitchtip.yml down -v     # + effacer les données
```
