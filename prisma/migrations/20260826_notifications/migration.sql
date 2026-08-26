-- Système de notifications : annonces, convocations, incidents envoyées aux parents
--
-- Permet aux admins/enseignants de communiquer directement avec les parents via FCM,
-- avec persistance jusqu'à marquage explicite "lu". Une notification peut cibler
-- un parent unique, tous les parents d'une classe, ou tous les parents de l'école.

-- Types de notifications
CREATE TYPE notification_type AS ENUM ('annonce', 'convocation', 'incident');

-- Types de ressources associables aux notifications (ex: mauvaise note, incident disciplinaire)
CREATE TYPE notification_resource_type AS ENUM ('grade', 'student', 'attendance', 'enrollment', 'other');

-- Types de ciblage destinataires
CREATE TYPE notification_target_type AS ENUM ('parent', 'class_parents', 'school_parents');

-- Table principale : notifications
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  creator_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  type notification_type NOT NULL,
  severity INTEGER DEFAULT 0 CHECK (severity IN (0, 1, 2)), -- 0=annonce, 1=convocation, 2=incident
  target_type notification_target_type NOT NULL,
  target_id INTEGER, -- classId ou parentUserId selon targetType
  resource_type notification_resource_type,
  resource_id INTEGER, -- gradeId, studentId, etc.
  metadata JSONB,
  created_at TIMESTAMP(6) DEFAULT NOW(),
  archived_at TIMESTAMP(6)
);

CREATE INDEX idx_notifications_school_created ON notifications(school_id, created_at);
CREATE INDEX idx_notifications_school_type ON notifications(school_id, type);
CREATE INDEX idx_notifications_creator ON notifications(creator_user_id);
CREATE INDEX idx_notifications_archived ON notifications(archived_at);

-- Table de liaison : notification destinataires
-- Un parent reçoit une notification, et peut la marquer comme lue indépendamment
CREATE TABLE notification_recipients (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  parent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMP(6),
  created_at TIMESTAMP(6) DEFAULT NOW(),
  archived_at TIMESTAMP(6),
  CONSTRAINT fk_recipient_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE,
  CONSTRAINT uk_recipient_unique UNIQUE(notification_id, parent_user_id)
);

CREATE INDEX idx_recipients_school_parent_read ON notification_recipients(school_id, parent_user_id, read_at);
CREATE INDEX idx_recipients_notification ON notification_recipients(notification_id);
CREATE INDEX idx_recipients_archived ON notification_recipients(archived_at);
