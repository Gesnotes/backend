# Design technique — Système de notifications (annonces, convocations, incidents)

## High-Level Design

### 1. Architecture générale

```
┌─────────────────────────────────────────────────────────────────┐
│                     Admin/Enseignant                             │
│              (crée une annonce/convocation/incident)             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend Express                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ POST /notifications (validation, archivage en DB)       │   │
│  │ - Crée la notification                                   │   │
│  │ - Enregistre les destinataires                           │   │
│  │ - Publie événement 'notification.created'               │   │
│  └─────────────────────────────────────────────────────────┘   │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Bus d'événements (src/lib/events.ts)                    │   │
│  │ notification.created → notificationService.sendPush()   │   │
│  └─────────────────────────────────────────────────────────┘   │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ NotificationService (src/services/notification.ts)      │   │
│  │ - Résout les destinataires (classe → parents)           │   │
│  │ - Envoie les push FCM (Firebase Admin SDK)              │   │
│  │ - Gère les erreurs d'envoi (retry, log)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬──────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │   Firebase Cloud Messaging       │
                    │   (push via FCM)                 │
                    └──────────────────────────────────┘
                                       │
                                       ▼
        ┌──────────────────────────────────────────────────┐
        │                Client Parent PWA                │
        │ ┌──────────────────────────────────────────┐   │
        │ │ Service Worker (src/sw.ts)               │   │
        │ │ - Reçoit notification FCM                │   │
        │ │ - showNotification() avec tag unique     │   │
        │ │ - Interception du clic                   │   │
        │ └──────────────────────────────────────────┘   │
        │           │                                    │
        │           ▼                                    │
        │ ┌──────────────────────────────────────────┐   │
        │ │ React (ParentHome.tsx)                   │   │
        │ │ - Affiche notifications non-lues         │   │
        │ │ - Bouton "Marquer comme lu"              │   │
        │ │ - Persistance IndexedDB                  │   │
        │ └──────────────────────────────────────────┘   │
        └──────────────────────────────────────────────────┘
```

### 2. Diagramme entités/relations

```sql
-- Tables principales

Notification
├── id (PK)
├── schoolId (FK → School)
├── creatorUserId (FK → User, admin ou enseignant)
├── title
├── body
├── type (enum: 'annonce' | 'convocation' | 'incident')
├── severity (0=annonce, 1=convocation, 2=incident)
├── targetType (enum: 'class' | 'parent' | 'class_parents')
├── targetId (class_id OU parent_user_id, selon targetType)
├── associatedResourceType (nullable: 'grade' | 'student' | 'attendance')
├── associatedResourceId (nullable: grade_id OU student_id, ...)
├── createdAt
├── archivedAt (soft-delete)
└── metadata (JSON: extra fields)

NotificationRecipient (table de liaison)
├── id (PK)
├── notificationId (FK → Notification, onDelete: Cascade)
├── schoolId (dénormalisé)
├── parentUserId (FK → User, rôle=parent)
├── readAt (null si non-lu)
├── createdAt
└── archivedAt

-- Garanties en base
- Clé composite (notificationId, parentUserId) pour éviter les doublons
- Index sur (schoolId, parentUserId, readAt) pour requêtes rapides
```

### 3. Flux de création (scenarios)

#### Scenario 1 : Admin crée une annonce pour tous les parents d'une classe
```
Admin Panel
  ↓
[Créer notification]
  - Type: Annonce
  - Target: Classe 6e A
  - Body: "Réunion parents le 15/09"
  ↓
POST /notifications
  - Valider (Zod)
  - Insérer Notification (targetType='class_parents', targetId=classId)
  - Récupérer tous les parents de la classe
  - Créer N lignes NotificationRecipient (une par parent)
  ↓
Événement: notification.created
  - Lister les DeviceTokens de chaque parent
  - Envoyer N pushes FCM (batch)
  ↓
Parents reçoivent notification
  - Service Worker l'affiche immédiatement
  - Reste lisible tant que non marquée comme "lue"
```

#### Scenario 2 : Enseignant crée une convocation pour un parent (mauvaise note)
```
Teacher Grade Entry
  ↓
[Saisir note: 8/20 → Seuil d'alerte]
  - Post-hook: Évaluer sévérité
  ↓
POST /notifications (auto ou manuel)
  - Type: Convocation
  - Target: Parent spécifique
  - Body: "Votre enfant a obtenu 8/20 en Maths"
  - associatedResourceType: 'grade'
  - associatedResourceId: gradeId
  ↓
Événement: notification.created
  - Envoyer push FCM au parent
  ↓
Parent reçoit push urgent
  - Clique → Service Worker redirige vers /parent/notes/{gradeId}
```

#### Scenario 3 : Admin crée un incident pour un parent
```
Discipline Module (future)
  ↓
[Enregistrer incident]
  - Type: Incident
  - Sévérité: 2 (élevée)
  - Body: "Incident disciplinaire signalé"
  - associatedResourceType: 'incident'
  - associatedResourceId: incidentId
  ↓
Événement: notification.created
  - Envoyer push FCM immédiatement
  - Badge numérique pour urgence
```

### 4. Composant UI (ParentHome)

```tsx
// src/pages/parent/ParentHome.tsx

export function ParentHome() {
  return (
    <section>
      <h1>Accueil</h1>
      
      {/* Section notifications non-lues */}
      <NotificationsList />
      
      {/* Reste de la page (notes, bulletins, etc.) */}
      <StudentGradesOverview />
    </section>
  )
}

// Component interne : NotificationsList
// - Affiche les notifications non-lues
// - Tri par sévérité (incident > convocation > annonce)
// - Badge rouge pour incident
// - Bouton "Marquer comme lu" par notification
// - Persistance: ne disparaît que après marquage
```

### 5. Service Worker — Gestion des clics

```ts
// src/sw.ts - Ajout
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data as { 
    url?: string
    notificationId?: number
    resourceType?: string
    resourceId?: number
  }
  
  if (data.url) {
    // Redirection directe (grade → /parent/notes/{id}, etc.)
    event.waitUntil(navigateTo(data.url))
  } else if (data.notificationId) {
    // Fallback: ouvrir /parent (page d'accueil)
    event.waitUntil(navigateTo('/parent'))
  }
})
```

---

## Low-Level Design

### 1. Schéma Prisma

```prisma
// Enum pour les types de notification
enum NotificationType {
  annonce
  convocation
  incident

  @@map("notification_type")
}

// Enum pour les ressources associées
enum NotificationResourceType {
  grade        // Mauvaise note
  student      // Incident sur élève
  attendance   // Absence
  enrollment   // Inscription
  other

  @@map("notification_resource_type")
}

// Enum pour les cibles
enum NotificationTargetType {
  parent           // Parent spécifique
  class_parents    // Tous les parents d'une classe
  school_parents   // Tous les parents de l'école

  @@map("notification_target_type")
}

// Table principale des notifications
model Notification {
  id                    Int                       @id @default(autoincrement())
  schoolId              Int                       @map("school_id")
  creatorUserId         Int                       @map("creator_user_id")
  title                 String                    @db.VarChar(200)
  body                  String                    @db.Text
  type                  NotificationType          @map("type")
  severity              Int                       @default(0) @map("severity") // 0=annonce, 1=convocation, 2=incident
  
  // Ciblage
  targetType            NotificationTargetType    @map("target_type")
  targetId              Int?                      @map("target_id") // classId ou parentUserId selon targetType
  
  // Ressource associée (optionnelle)
  resourceType          NotificationResourceType? @map("resource_type")
  resourceId            Int?                      @map("resource_id") // gradeId, studentId, etc.
  
  // Métadonnées
  metadata              Json?
  createdAt             DateTime                  @default(now()) @map("created_at") @db.Timestamp(6)
  archivedAt            DateTime?                 @map("archived_at") @db.Timestamp(6)

  school        School                @relation(fields: [schoolId], references: [id], onDelete: Cascade)
  creator       User                  @relation(fields: [creatorUserId], references: [id])
  recipients    NotificationRecipient[]

  @@index([schoolId, createdAt])
  @@index([schoolId, type])
  @@index([creatorUserId])
  @@map("notifications")
}

// Table de liaison : notification ↔ parent (destinataire)
model NotificationRecipient {
  id              Int       @id @default(autoincrement())
  schoolId        Int       @map("school_id") // dénormalisé pour isolation
  notificationId  Int       @map("notification_id")
  parentUserId    Int       @map("parent_user_id")
  readAt          DateTime? @map("read_at") @db.Timestamp(6)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamp(6)
  archivedAt      DateTime? @map("archived_at") @db.Timestamp(6)

  notification Notification @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  parent       User         @relation(fields: [parentUserId], references: [id], onDelete: Cascade)

  // Garantir qu'on n'enregistre pas deux fois le même parent pour une notification
  @@unique([notificationId, parentUserId])
  @@index([schoolId, parentUserId, readAt])
  @@index([notificationId])
  @@map("notification_recipients")
}
```

**Migration SQL** (`prisma/migrations/20260826_notifications/migration.sql`)
```sql
-- Enum types
CREATE TYPE notification_type AS ENUM ('annonce', 'convocation', 'incident');
CREATE TYPE notification_resource_type AS ENUM ('grade', 'student', 'attendance', 'enrollment', 'other');
CREATE TYPE notification_target_type AS ENUM ('parent', 'class_parents', 'school_parents');

-- Table notifications
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  type notification_type NOT NULL,
  severity INTEGER DEFAULT 0,
  target_type notification_target_type NOT NULL,
  target_id INTEGER,
  resource_type notification_resource_type,
  resource_id INTEGER,
  metadata JSONB,
  created_at TIMESTAMP(6) DEFAULT NOW(),
  archived_at TIMESTAMP(6)
);

CREATE INDEX idx_notifications_school_created ON notifications(school_id, created_at);
CREATE INDEX idx_notifications_school_type ON notifications(school_id, type);
CREATE INDEX idx_notifications_creator ON notifications(creator_user_id);

-- Table notification_recipients
CREATE TABLE notification_recipients (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  parent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP(6),
  created_at TIMESTAMP(6) DEFAULT NOW(),
  archived_at TIMESTAMP(6),
  CONSTRAINT fk_recipient_school FOREIGN KEY (school_id) REFERENCES schools(id),
  UNIQUE(notification_id, parent_user_id)
);

CREATE INDEX idx_recipients_school_parent_read ON notification_recipients(school_id, parent_user_id, read_at);
CREATE INDEX idx_recipients_notification ON notification_recipients(notification_id);
```

### 2. Routes API

```ts
// src/routes/notification.routes.ts

router.post('/notifications', requireRole('admin', 'teacher'), validateBody(createNotificationSchema), async (req, res) => {
  // POST /notifications
  // Créer une notification et envoyer les push
  // Validation:
  //  - Creator est admin (action école) ou enseignant (sa classe)
  //  - Target existe (classe ou parent de l'école)
  // Réponse: { id, createdAt, recipientCount }
})

router.get('/notifications', requireRole('parent'), async (req, res) => {
  // GET /notifications?unread=true&limit=20&offset=0
  // Lister les notifications du parent (connecté)
  // Filtre: unread=true → readAt IS NULL
  // Réponse: { notifications: [...], totalCount }
})

router.patch('/notifications/:id/read', requireRole('parent'), async (req, res) => {
  // PATCH /notifications/{id}/read
  // Marquer une notification comme lue (readAt = now())
  // Validation: parent owns this notification
  // Réponse: { readAt }
})

router.delete('/notifications/:id', requireRole('admin'), async (req, res) => {
  // DELETE /notifications/{id}?permanent=true&confirm_label=...
  // Archiver (par défaut) ou supprimer définitivement
  // Suit le pattern archive/restore/permanent-delete établi
})
```

**Schémas Zod**
```ts
// src/lib/validationSchemas.ts

export const createNotificationSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  type: z.enum(['annonce', 'convocation', 'incident']),
  severity: z.number().int().min(0).max(2).optional(),
  targetType: z.enum(['parent', 'class_parents', 'school_parents']),
  targetId: z.number().int().nullable().optional(),
  resourceType: z.enum(['grade', 'student', 'attendance', 'enrollment', 'other']).nullable().optional(),
  resourceId: z.number().int().nullable().optional(),
});
```

### 3. Service métier — NotificationService

```ts
// src/services/notification.service.ts

export class NotificationService {
  /**
   * Créer une notification et enregistrer ses destinataires
   * Retourne l'ID créé pour publication d'événement
   */
  async create(
    req: Request,
    input: CreateNotificationInput
  ): Promise<{ id: number; recipientCount: number }> {
    // 1. Valider les permissions du créateur
    if (req.user.role === 'teacher') {
      // Enseignant ne peut créer que pour ses classes
      // Vérifier que targetId (classId) est dans ses affectations
    }

    // 2. Créer la notification
    const notification = await prisma.notification.create({
      data: {
        schoolId: req.schoolId,
        creatorUserId: req.user.id,
        title: input.title,
        body: input.body,
        type: input.type,
        severity: input.severity ?? (input.type === 'annonce' ? 0 : input.type === 'convocation' ? 1 : 2),
        targetType: input.targetType,
        targetId: input.targetId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
    });

    // 3. Résoudre les destinataires selon targetType
    const parentIds = await this.resolveRecipients(
      req.schoolId,
      input.targetType,
      input.targetId
    );

    // 4. Créer les lignes NotificationRecipient
    await prisma.notificationRecipient.createMany({
      data: parentIds.map(parentId => ({
        schoolId: req.schoolId,
        notificationId: notification.id,
        parentUserId: parentId,
      })),
    });

    return {
      id: notification.id,
      recipientCount: parentIds.length,
    };
  }

  /**
   * Résoudre les parents destinataires selon le type de ciblage
   */
  private async resolveRecipients(
    schoolId: number,
    targetType: NotificationTargetType,
    targetId?: number
  ): Promise<number[]> {
    if (targetType === 'parent') {
      // Parent unique
      return [targetId!];
    } else if (targetType === 'class_parents') {
      // Tous les parents de la classe
      const parents = await prisma.studentParent.findMany({
        where: {
          student: {
            classId: targetId!,
            schoolId,
          },
        },
        select: { parentUserId: true },
        distinct: ['parentUserId'],
      });
      return parents.map(p => p.parentUserId);
    } else if (targetType === 'school_parents') {
      // Tous les parents de l'école
      const parents = await prisma.user.findMany({
        where: {
          schoolId,
          role: 'parent',
        },
        select: { id: true },
      });
      return parents.map(p => p.id);
    }
    return [];
  }

  /**
   * Envoyer les push FCM (appelé via bus d'événements)
   */
  async sendPush(notificationId: number): Promise<void> {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      include: { recipients: true },
    });

    if (!notification) return;

    // Regrouper par parent et récupérer ses devices
    const parentIds = notification.recipients.map(r => r.parentUserId);
    const devices = await prisma.device.findMany({
      where: {
        userId: { in: parentIds },
      },
    });

    const tokens = devices.map(d => d.fcmToken);

    // Envoyer batch
    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
      },
      data: {
        notificationId: String(notification.id),
        type: notification.type,
        severity: String(notification.severity),
        resourceType: notification.resourceType ?? '',
        resourceId: notification.resourceId ?? '',
      },
      webpush: {
        fcmOptions: {
          link: this.resolveLink(notification),
        },
      },
    };

    // Envoyer via Firebase Admin SDK
    await getMessaging().sendMulticast({
      ...message,
      tokens,
    });
  }

  /**
   * Résoudre l'URL de redirection pour le clic de notification
   */
  private resolveLink(notification: Notification): string {
    if (notification.resourceType === 'grade' && notification.resourceId) {
      return `/parent/notes/${notification.resourceId}`;
    }
    if (notification.resourceType === 'student' && notification.resourceId) {
      return `/parent/student/${notification.resourceId}`;
    }
    return '/parent';
  }

  /**
   * Marquer une notification comme lue
   */
  async markAsRead(
    req: Request,
    notificationId: number
  ): Promise<{ readAt: Date }> {
    // Vérifier que le parent possède cette notification
    const recipient = await prisma.notificationRecipient.findFirst({
      where: {
        notificationId,
        parentUserId: req.user.id,
        schoolId: req.schoolId,
      },
    });

    if (!recipient) throw new ForbiddenError();

    const updated = await prisma.notificationRecipient.update({
      where: { id: recipient.id },
      data: { readAt: new Date() },
      select: { readAt: true },
    });

    return updated;
  }

  /**
   * Lister les notifications du parent
   */
  async listForParent(
    req: Request,
    filters: {
      unread?: boolean;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ notifications: any[]; totalCount: number }> {
    const where: Prisma.NotificationRecipientWhereInput = {
      parentUserId: req.user.id,
      schoolId: req.schoolId,
      archivedAt: null,
    };

    if (filters.unread) {
      where.readAt = null;
    }

    const [notifications, totalCount] = await Promise.all([
      prisma.notificationRecipient.findMany({
        where,
        include: {
          notification: true,
        },
        orderBy: {
          notification: {
            createdAt: 'desc',
          },
        },
        take: filters.limit ?? 20,
        skip: filters.offset ?? 0,
      }),
      prisma.notificationRecipient.count({ where }),
    ]);

    return {
      notifications: notifications.map(r => ({
        id: r.notification.id,
        ...r.notification,
        readAt: r.readAt,
      })),
      totalCount,
    };
  }
}
```

### 4. Intégration au bus d'événements

```ts
// src/lib/events.ts (modification existante)

export const events = new EventEmitter();

// Ajouter:
events.on('notification.created', async (notificationId: number) => {
  try {
    await notificationService.sendPush(notificationId);
  } catch (err) {
    logger.error('Failed to send notification push', { notificationId, err });
  }
});
```

### 5. Composant React (ParentHome)

```tsx
// src/pages/parent/ParentHome.tsx

import { useQuery } from '@tanstack/react-query';
import { NotificationCard } from '@/ui/NotificationCard';

export function ParentHome() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['notifications', { unread: true }],
    queryFn: async () => {
      const res = await fetch('/api/notifications?unread=true');
      if (!res.ok) throw new Error('Erreur lors du chargement des notifications');
      return res.json();
    },
    refetchInterval: 30000, // Recharger toutes les 30s
  });

  if (isLoading) return <div>Chargement...</div>;
  if (error) return <div>Erreur</div>;

  const notifications = data?.notifications ?? [];

  return (
    <main className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Accueil</h1>

      {/* Section notifications */}
      {notifications.length > 0 && (
        <section className="mb-8 p-4 bg-warning/10 rounded-lg border-l-4 border-warning">
          <h2 className="text-lg font-semibold mb-4">Notifications ({notifications.length})</h2>
          <div className="space-y-3">
            {notifications
              .sort((a, b) => b.severity - a.severity) // Incidents en premier
              .map(notification => (
                <NotificationCard
                  key={notification.id}
                  notification={notification}
                />
              ))}
          </div>
        </section>
      )}

      {/* Reste de la page */}
      <StudentGradesOverview />
    </main>
  );
}
```

```tsx
// src/ui/NotificationCard.tsx

export function NotificationCard({ notification }: { notification: Notification }) {
  const [marking, setMarking] = useState(false);
  const queryClient = useQueryClient();

  const handleMarkAsRead = async () => {
    setMarking(true);
    try {
      await fetch(`/api/notifications/${notification.id}/read`, { method: 'PATCH' });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } finally {
      setMarking(false);
    }
  };

  const severity = {
    0: { label: 'Annonce', tone: 'neutral' },
    1: { label: 'Convocation', tone: 'warning' },
    2: { label: 'Incident', tone: 'danger' },
  };

  const s = severity[notification.severity as 0 | 1 | 2];

  return (
    <div className={`p-3 rounded border-l-4 bg-${s.tone}/5 border-${s.tone}`}>
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <p className="text-sm font-semibold text-gray-600">{s.label}</p>
          <h3 className="font-bold text-base">{notification.title}</h3>
          <p className="text-sm mt-1">{notification.body}</p>
          <p className="text-xs text-gray-500 mt-2">
            {new Date(notification.createdAt).toLocaleDateString('fr-FR')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleMarkAsRead}
          disabled={marking}
        >
          Marquer comme lu
        </Button>
      </div>
    </div>
  );
}
```

### 6. Service Worker — Interception des clics

```ts
// src/sw.ts (modification existante)

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data as {
    url?: string;
    notificationId?: string;
    resourceType?: string;
    resourceId?: string;
  };

  event.notification.close();

  let targetUrl = '/parent';

  if (data.resourceType === 'grade' && data.resourceId) {
    targetUrl = `/parent/notes/${data.resourceId}`;
  } else if (data.resourceType === 'student' && data.resourceId) {
    targetUrl = `/parent/student/${data.resourceId}`;
  } else if (data.url) {
    targetUrl = data.url;
  }

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          await client.focus();
          await client.navigate(targetUrl);
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
```

---

## Correctness Properties

### Property 1 : « Une notification marquée comme lue disparaît de la liste »
```
Pour tout parent P et notification N:
  Si N.readAt ≠ null ET N.parentUserId = P.id
  Alors N ne figure pas dans GET /notifications?unread=true
```

### Property 2 : « Seuls les parents ciblés reçoivent la notification »
```
Pour toute notification N créée avec targetType='class_parents' et targetId=C:
  NotificationRecipient.parentUserId ∈ {Parents de classe C}
  ET NotificationRecipient.parentUserId ∉ {Parents d'autres classes}
```

### Property 3 : « Une notification archivée n'envoie pas de push »
```
Si Notification.archivedAt ≠ null
  Alors ¬∃ FCM message envoyé pour cette notification
```

### Property 4 : « L'isolation multi-écoles est garantie »
```
Pour toute requête GET /notifications par parent P de l'école S:
  Tous les notifications.schoolId = S
  ET tous les recipients.parentUserId = P.id
```

---

## Risques et dépendances

### Risques

1. **Rate-limiting FCM** : Envoyer N notifications à beaucoup de parents en même temps peut déclencher le throttling Firebase. **Mitigation** : Implémenter un queue d'envoi avec exponential backoff, envoyer par batch de 500 tokens max.

2. **Tokens FCM invalides** : Les appareils se désinscrivent, tokens expirent. **Mitigation** : Gérer les erreurs FCM (unregistered token → supprimer Device), logger les erreurs.

3. **Cache PWA stale** : Si un parent a une ancienne version en cache, les notifications ne s'affichent pas. **Mitigation** : Service Worker actualise le cache après chaque nouvelle version (déjà en place avec `registerType: 'prompt'`).

4. **Synchronisation offline** : Si parent crée offline une notification avant de la marquer comme lue, puis se reconnecte. **Mitigation** : NotificationRecipient.readAt est atomique au niveau DB, pas de race condition IndexedDB.

### Dépendances

- **Firebase Admin SDK** : Déjà présent dans backend (`firebase-admin`)
- **Prisma 7** : Déjà présent
- **React Query** : Déjà présent au frontend
- **Service Worker** : Déjà configuré dans `src/sw.ts`

### Implémentation future (phase 2)

- Auto-création de notifications pour mauvaises notes (hook sur `grade.created`)
- Module Incidents (entité dédiée avec workflow d'escalade)
- Webhooks pour notifier parents via email en parallèle
- Archivage automatique des notifications > 90 jours

