# Task List — Système de notifications

## Phase 1 : Modèle métier et API Backend

### Task 1.1 : Créer les migrations Prisma pour Notification et NotificationRecipient
- **Description** : Écrire la migration SQL pour les deux tables (notifications, notification_recipients) avec les enums (type, resourceType, targetType)
- **Acceptance Criteria**
  - Migration créée dans `prisma/migrations/20260826_notifications/`
  - Enums générés correctement
  - Index sur (schoolId, createdAt), (schoolId, parentUserId, readAt)
  - Clé composite (notificationId, parentUserId)
  - Tests unitaires SQL : migration ↔ rollback
- **Dépendances** : Aucune (branche feature)
- **Estimation** : 2h
- **Priorité** : P0 — bloquant pour le reste

---

### Task 1.2 : Générer le client Prisma et types TypeScript
- **Description** : Exécuter `prisma generate` et vérifier que les types sont corrects dans `src/generated/prisma`
- **Acceptance Criteria**
  - `npm run typecheck` passe
  - Modèles Notification et NotificationRecipient ont tous les champs
  - Types d'enums corrects
- **Dépendances** : Task 1.1
- **Estimation** : 30min
- **Priorité** : P0

---

### Task 1.3 : Implémenter NotificationService (CRUD + envoi FCM)
- **Description** : Créer `src/services/notification.service.ts` avec méthodes : create, listForParent, markAsRead, sendPush, resolveRecipients
- **Acceptance Criteria**
  - Méthode `create()` : valide permissions, crée Notification + NotificationRecipient
  - Méthode `resolveRecipients()` : résout parents selon targetType (parent unique, classe, école)
  - Méthode `sendPush()` : envoie batch FCM via firebase-admin
  - Méthode `listForParent()` : retourne notifications avec filtres (unread, limit, offset)
  - Méthode `markAsRead()` : met à jour readAt
  - Gestion d'erreurs : token FCM invalid → supprimer Device
  - Tests unitaires pour chaque méthode (80%+ coverage)
- **Dépendances** : Task 1.2
- **Estimation** : 8h
- **Priorité** : P0

---

### Task 1.4 : Créer les schémas Zod de validation
- **Description** : Définir createNotificationSchema, updateNotificationSchema, etc.
- **Acceptance Criteria**
  - Zod v4 avec locale FR
  - Validations : min/max longueur, enums, types
  - Messages d'erreur en français clair
  - Schémas testés avec `npm test`
- **Dépendances** : Task 1.1
- **Estimation** : 2h
- **Priorité** : P0

---

### Task 1.5 : Créer les routes Express pour les notifications
- **Description** : Implémenter POST /notifications, GET /notifications, PATCH /notifications/{id}/read, DELETE /notifications/{id}
- **Acceptance Criteria**
  - POST : crée notification, retourne id + recipientCount
  - GET : liste notifications du parent connecté (unread filter, pagination)
  - PATCH : marque comme lu
  - DELETE : archive ou supprime définitivement (pattern existant)
  - Middleware : requireRole, schoolContext
  - Tests E2E : supertest + fixtures
- **Dépendances** : Task 1.3, Task 1.4
- **Estimation** : 5h
- **Priorité** : P0

---

### Task 1.6 : Intégrer événement notification.created au bus
- **Description** : Écouter notification.created et appeler notificationService.sendPush() dans src/lib/events.ts
- **Acceptance Criteria**
  - Event listener enregistré dans events.ts
  - sendPush() est appelé asynchronement
  - Erreurs loggées sans bloquer
  - Tests : émettre notification.created → vérifier que sendPush() est appelé
- **Dépendances** : Task 1.3, Task 1.5
- **Estimation** : 2h
- **Priorité** : P0

---

### Task 1.7 : Écrire tests d'intégration backend
- **Description** : Tests complets du flux (création → envoi FCM → marquage lu)
- **Acceptance Criteria**
  - Test : admin crée notification pour classe → 5 parents reçoivent
  - Test : enseignant ne peut pas créer pour une autre classe
  - Test : parent A ne voit pas notification de parent B
  - Test : FCM token invalid → supprimé
  - Test : marquage lu visible immédiatement après
  - Couverture ≥ 90%
- **Dépendances** : Task 1.5, Task 1.6
- **Estimation** : 6h
- **Priorité** : P1

---

## Phase 2 : Frontend et UI

### Task 2.1 : Créer l'API client (fetch wrapper)
- **Description** : Ajouter des fonctions dans `src/api/notification.ts` : fetchNotifications, markAsRead, createNotification (pour future UI admin)
- **Acceptance Criteria**
  - Endpoint abstraits derrière des fonctions
  - Gestion d'erreurs via ApiError.ts existant
  - Support offline future (offlineQueue hook)
  - Types TypeScript corrects
- **Dépendances** : Task 1.5
- **Estimation** : 2h
- **Priorité** : P0

---

### Task 2.2 : Créer le composant NotificationCard
- **Description** : Composant React réutilisable pour afficher une notification avec badge sévérité + bouton "Marquer comme lu"
- **Acceptance Criteria**
  - Props : notification (title, body, type, severity, createdAt)
  - Badge couleur selon sévérité (neutral/warning/danger)
  - Bouton cliquable, état loading
  - Accessible (a11y) : roles, labels
  - Responsive : desktop et mobile
- **Dépendances** : Task 2.1
- **Estimation** : 3h
- **Priorité** : P0

---

### Task 2.3 : Créer le composant NotificationsList
- **Description** : Conteneur qui liste les notifications du parent avec React Query
- **Acceptance Criteria**
  - Fetch avec useQuery (queryKey: ['notifications', { unread: true }])
  - Rafraîchissement auto 30s (refetchInterval)
  - Tri par sévérité (incident > convocation > annonce)
  - Gestion d'erreur via QueryBoundary
  - État vide : "Aucune notification"
  - Pagination optionnelle future
- **Dépendances** : Task 2.1, Task 2.2
- **Estimation** : 3h
- **Priorité** : P0

---

### Task 2.4 : Intégrer NotificationsList à ParentHome
- **Description** : Ajouter la section notifications en haut de la page d'accueil parent
- **Acceptance Criteria**
  - Section affichée seulement s'il y a des non-lues
  - Avant les autres sections (grades, bulletins)
  - Style cohérent avec DESIGN.md
  - Section disparaît après marquage comme lu
  - Responsive
- **Dépendances** : Task 2.3
- **Estimation** : 2h
- **Priorité** : P0

---

### Task 2.5 : Mettre à jour le Service Worker pour notifications
- **Description** : Améliorer src/sw.ts pour intercepter les clics de notification FCM
- **Acceptance Criteria**
  - addEventListener('notificationclick') gère le clic
  - Redirection vers /parent/notes/{gradeId} ou /parent/student/{id} selon resourceType
  - Fallback /parent si pas de ressource
  - Onglet existant réutilisé si possible
  - Tests : simuler clic FCM
- **Dépendances** : Task 1.5 (API existante), Task 2.1
- **Estimation** : 2h
- **Priorité** : P0

---

### Task 2.6 : Tests e2e frontend
- **Description** : Tests React + Vitest pour les composants
- **Acceptance Criteria**
  - Test : NotificationCard affiche titre/corps/bouton
  - Test : clic "Marquer comme lu" appelle l'API
  - Test : NotificationsList affiche liste triée
  - Test : ParentHome affiche section si notifications
  - Couverture ≥ 80%
- **Dépendances** : Task 2.4, Task 2.5
- **Estimation** : 5h
- **Priorité** : P1

---

## Phase 3 : Audit et intégration

### Task 3.1 : Ajouter logs AuditLog pour notification.created
- **Description** : Enregistrer chaque création dans la table AuditLog (action='notification.created', metadata={type, severity, count})
- **Acceptance Criteria**
  - AuditLog inséré après création réussie
  - Métadonnées contiennent type, sévérité, nombre de destinataires
  - Tests : vérifier AuditLog.created après POST /notifications
- **Dépendances** : Task 1.5
- **Estimation** : 1h
- **Priorité** : P2

---

### Task 3.2 : Documentation API (OpenAPI/Swagger)
- **Description** : Documenter les endpoints dans un fichier OpenAPI
- **Acceptance Criteria**
  - POST /notifications documenté
  - GET /notifications documenté
  - PATCH /notifications/{id}/read documenté
  - Schémas des réponses
  - Format OpenAPI 3.0 ou Swagger 2.0
- **Dépendances** : Task 1.5
- **Estimation** : 2h
- **Priorité** : P2

---

### Task 3.3 : Tests d'acceptation end-to-end
- **Description** : Tests complets scénarios utilisateur (admin crée → parent reçoit → parent marque)
- **Acceptance Criteria**
  - Test 1 : Admin crée annonce pour classe → parent reçoit et voit en home
  - Test 2 : Enseignant crée convocation pour parent → affichée avec badge orange
  - Test 3 : Parent marque comme lu → disparaît
  - Tests lancés via `npm test`
- **Dépendances** : Task 1.7, Task 2.6
- **Estimation** : 4h
- **Priorité** : P2

---

### Task 3.4 : Nettoyage et code review
- **Description** : Code review interne, nettoyage de warnings/logs, vérification conventions
- **Acceptance Criteria**
  - `npm run typecheck` : 0 erreur
  - `npm run lint` : 0 erreur
  - `npm test` : 100% des tests passent
  - Commentaires en français
  - Messages d'erreur utilisateur clairs et en français
  - Aucun secret/token en logs
- **Dépendances** : Tasks précédentes
- **Estimation** : 3h
- **Priorité** : P0 (avant PR)

---

## Task Dependency Graph

```
Phase 1 (Backend)
    1.1 (Migrations)
      ↓
    1.2 (Prisma generate)
      ↓
    1.3 (NotificationService)
    1.4 (Zod schemas) ─┐
                       ├→ 1.5 (Routes Express)
                       ┘    ↓
                         1.6 (Events)
                           ↓
                         1.7 (Tests integ)

Phase 2 (Frontend)
    2.1 (API client) ← 1.5
      ↓
    2.2 (NotificationCard)
      ↓
    2.3 (NotificationsList)
      ↓
    2.4 (Integ ParentHome)
      ↓
    2.5 (Service Worker)
      ↓
    2.6 (Tests frontend)

Phase 3 (Finalization)
    3.1 (AuditLog) ← 1.5
    3.2 (Documentation) ← 1.5
    3.3 (E2E tests) ← 1.7, 2.6
      ↓
    3.4 (Code review)
```

## Estimation totale

- Phase 1 : 26h
- Phase 2 : 17h
- Phase 3 : 10h
- **Total : ~53h de développement** (2-3 sprints de 2 semaines)

## Notes de livraison

1. **Branche** : Créer `feat/notification-system` depuis `origin/dev`
2. **PR** : Ouvrir contre `dev` après Phase 1 + Phase 2 (avant Phase 3 possible)
3. **Rollout** : Feature invisible en production jusqu'à premier test (aucun UI admin pour créer, tant que pas implémenté)
4. **Monitoring** : Monitorer logs d'erreurs FCM après livraison

