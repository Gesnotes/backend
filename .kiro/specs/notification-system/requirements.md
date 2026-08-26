# Requirements — Système de notifications

## Introduction

Le système de notifications permet aux admins et enseignants d'envoyer des messages aux parents via la PWA. Les notifications restent affichées sur la page d'accueil des parents jusqu'à marquage explicite « lu », et déclenchent des push FCM immédiatement.

## Requirements fonctionnels

### Groupe 1 : Création et envoi

#### Requirement 1 : Créer une notification

**User Story :** En tant qu'admin ou enseignant, je veux créer une annonce/convocation/incident ciblant un parent, une classe, ou tous les parents de mon école, pour communiquer des informations importantes ou urgentes.

**Acceptance Criteria**

1. Un admin peut créer une notification de tout type (annonce, convocation, incident) ciblant n'importe quel parent, classe ou école de son établissement.
2. Un enseignant peut créer une notification uniquement pour ses propres classes.
3. Chaque notification porte :
   - Un titre (1-200 caractères)
   - Un corps (1-5000 caractères)
   - Un type (annonce | convocation | incident)
   - Une sévérité auto-déterminée (0=annonce, 1=convocation, 2=incident)
   - Une cible (parent unique, classe, ou tous les parents de l'école)
   - Un lien optionnel vers une ressource (note, élève, incident)
4. La création valide que la cible existe (classe, parent, école) et appartient à l'établissement du créateur.
5. La notification est immédiatement enregistrée en base de données.

---

#### Requirement 2 : Résoudre les destinataires

**User Story :** En tant que système, je veux automatiquement identifier tous les parents destinataires d'une notification selon son type de ciblage.

**Acceptance Criteria**

1. Si cible = parent unique → 1 destinataire.
2. Si cible = classe → tous les parents de cette classe (union des parents de chaque élève).
3. Si cible = école → tous les parents inscrits dans l'établissement.
4. Aucun doublon : si un parent figure déjà (ex. parent de 2 élèves de la même classe), il n'apparaît qu'une fois.
5. L'isolation multi-écoles est garantie : aucun parent d'une autre école ne peut être inclus accidentellement.

---

#### Requirement 3 : Envoyer les push FCM

**User Story :** En tant que système, je veux envoyer une notification push immédiate à chaque destinataire via Firebase Cloud Messaging.

**Acceptance Criteria**

1. Après création, un événement `notification.created` est publié sur le bus d'événements.
2. Le service notificationService écouteur envoie un push FCM à chaque device des parents destinataires.
3. Les push sont envoyés par batch (max 500 tokens par appel Firebase).
4. Le payload contient :
   - Titre, corps (affichage utilisateur)
   - Type, sévérité (métadonnées)
   - Lien de redirection (naviguer vers la ressource associée ou /parent)
5. Les erreurs d'envoi (token invalid, quota) sont loggées sans bloquer les autres destinataires.
6. Un dispositif dont le token est rejeté (unregistered) est automatiquement supprimé de la base.

---

### Groupe 2 : Affichage et persistance

#### Requirement 4 : Afficher les notifications non-lues

**User Story :** En tant que parent, je veux voir toutes mes notifications non-lues dès mon arrivée sur la page d'accueil pour rester informé des informations importantes.

**Acceptance Criteria**

1. La page d'accueil parent affiche une section « Notifications » listant uniquement les notifications marquées comme non-lues (readAt = null).
2. Les notifications sont triées par sévérité décroissante (incident > convocation > annonce).
3. Chaque notification affiche :
   - Un badge visuel indiquant sa sévérité (couleur rouge pour incident, orange pour convocation, neutre pour annonce).
   - Le titre et corps.
   - La date de création.
   - Un bouton « Marquer comme lu ».
4. La section disparaît si aucune notification non-lue n'existe.
5. Le chargement initialise une requête GET /notifications?unread=true et rafraîchit tous les 30 secondes.

---

#### Requirement 5 : Marquer comme lu

**User Story :** En tant que parent, je veux marquer une notification comme lue pour indiquer que je l'ai consultée et la retirer de mon affichage prioritaire.

**Acceptance Criteria**

1. En cliquant « Marquer comme lu » sur une notification, une requête PATCH /notifications/{id}/read est envoyée.
2. La notification disparaît immédiatement de la liste (optimistic update).
3. Le serveur met à jour notificationRecipient.readAt à l'instant actuel.
4. La validation vérifie que le parent connecté est bien destinataire de la notification.
5. Les notifications lues continuent d'exister en base (jamais supprimées, sauf soft-delete admin).

---

#### Requirement 6 : Persistance sur page d'accueil

**User Story :** En tant que parent, les notifications non-lues doivent rester affichées chaque fois que je visite la page d'accueil jusqu'à ce que je les marque comme lues.

**Acceptance Criteria**

1. Les notifications non-lues ne sont pas supprimées après consultation ou rechargement de page.
2. Aucun masquage automatique (ex. après un délai) : seul le clic « Marquer comme lu » les retire.
3. La liste se met à jour automatiquement via le rafraîchissement de requête React Query (30s).
4. En cas d'offline, les notifications déjà chargées restent visibles ; le marquage « lu » offline rejoue au retour en ligne (futur : offlineQueue).

---

### Groupe 3 : Permissions et isolation

#### Requirement 7 : Contrôle d'accès créateurs

**User Story :** En tant que système de sécurité, je veux garantir que seuls les admins et enseignants autorisés peuvent créer des notifications.

**Acceptance Criteria**

1. POST /notifications requiert le rôle admin ou teacher (middleware requireRole).
2. Un admin peut créer pour n'importe quel parent, classe ou école de son établissement.
3. Un enseignant peut créer uniquement pour ses propres classes (vérification: classId ∈ TeacherAssignment.classId).
4. Un parent ne peut pas créer de notification.
5. Un parent ne peut jamais voir ni modifier les notifications d'un autre parent (même école).

---

#### Requirement 8 : Isolation multi-écoles

**User Story :** En tant que système multi-tenant, je veux garantir que chaque école ne voit que ses propres notifications.

**Acceptance Criteria**

1. Chaque Notification et NotificationRecipient porte un schoolId dénormalisé.
2. Toute requête filtre explicitement par schoolId du JWT (dérivé du contexte d'authentification).
3. Un parent d'école A ne peut jamais voir les notifications d'école B, même avec un token d'une autre école.
4. Les clés composites (notificationId, parentUserId) garantissent l'unicité par école.

---

### Groupe 4 : Notifications push

#### Requirement 9 : Push immédiate et silencieuse en background

**User Story :** En tant que parent, je veux recevoir une notification push même si l'application n'est pas ouverte, pour rester informé en temps réel.

**Acceptance Criteria**

1. Le service worker reçoit le message FCM en background (onBackgroundMessage).
2. La notification est affichée immédiatement dans le centre de notifications du téléphone.
3. Le titre, corps et icône sont visibles et compréhensibles.
4. Chaque notification porte un tag unique (notification-{id}) pour ne pas écraser les autres.
5. Un clic sur la notification envoie le parent vers :
   - /parent/notes/{gradeId} si la notification concerne une note
   - /parent/student/{studentId} si elle concerne un élève
   - /parent sinon

---

#### Requirement 10 : Gestion des erreurs d'envoi FCM

**User Story :** En tant que système de notification, je veux gérer les erreurs d'envoi FCM sans perdre les destinataires valides.

**Acceptance Criteria**

1. Si un token FCM est invalide (unregistered), il est supprimé automatiquement de la table Device.
2. Si l'envoi échoue pour d'autres raisons (quota, réseau), l'erreur est loggée mais n'interrompt pas l'envoi aux autres destinataires.
3. Les tokens rejetés ne sont pas réessayés immédiatement (exponential backoff future).
4. Les métriques (nombre envoyé, nombre échoué) sont enregistrées en logs pour audit.

---

## Requirements non-fonctionnels

### Requirement 11 : Performance

**Acceptance Criteria**

1. Lister les notifications d'un parent : < 500 ms (index sur (schoolId, parentUserId, readAt)).
2. Créer une notification pour 100 parents : < 5 s (batch FCM, requêtes parallèles).
3. Marquer comme lu : < 200 ms.

---

### Requirement 12 : Fiabilité et durabilité

**Acceptance Criteria**

1. Les notifications ne sont jamais perdues : une fois créées, elles restent en base même si l'envoi FCM échoue.
2. Les push FCM sont envoyés au moins une fois (pas de garantie de livraison FCM elle-même, c'est au fournisseur).
3. Les erreurs ne bloquent pas l'application : le service des notes, du bulletin continue même si les notifications échouent.

---

### Requirement 13 : Conformité audit

**Acceptance Criteria**

1. Chaque création de notification est enregistrée dans AuditLog avec action='notification.created'.
2. Les métadonnées incluent le type, la sévérité, le nombre de destinataires.
3. Les suppressions définitives requièrent le retapage du titre exact (pattern existant).

---

## Glossaire

| Terme | Définition |
|-------|-----------|
| Annonce | Notification de basse urgence (sévérité 0), ex. réunion parents. |
| Convocation | Notification de moyenne urgence (sévérité 1), ex. mauvaise note. |
| Incident | Notification de haute urgence (sévérité 2), ex. incident disciplinaire. |
| destinataire | Parent qui recevra la notification (parent unique, tous parents de classe, tous parents d'école). |
| readAt | Timestamp quand le parent a marqué la notification comme lue (null = non-lue). |
| Service Worker | Worker JS qui reçoit et affiche les push FCM en background. |
| FCM | Firebase Cloud Messaging — service de push Google. |

