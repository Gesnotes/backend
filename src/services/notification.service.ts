import prisma from '../lib/prisma';
import type { AttendanceEvent, GradeEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { webAppUrl } from '../lib/env';
import { emitEvent, onEvent } from '../lib/events';
import { pushSender } from '../lib/push';
import { minutesToHHMM } from './schedule.service';
import { notFound, badRequest, forbidden } from '../errors/AppError';
import type { NotificationType, NotificationTargetType, NotificationResourceType } from '../generated/prisma/enums';

export interface CreateNotificationParams {
  schoolId: number;
  creatorUserId: number;
  title: string;
  body: string;
  type: NotificationType;
  severity: number;
  targetType: NotificationTargetType;
  targetId?: number | null;
  resourceType?: NotificationResourceType | null;
  resourceId?: number | null;
}

/**
 * Créer et distribuer une notification (annonce, convocation, incident grave) aux parents.
 */
export async function createNotification(params: CreateNotificationParams) {
  const {
    schoolId,
    creatorUserId,
    title,
    body,
    type,
    severity,
    targetType,
    targetId,
    resourceType,
    resourceId,
  } = params;

  // Vérification des droits et du périmètre si le créateur est un enseignant
  const creator = await prisma.user.findUnique({
    where: { id: creatorUserId },
    select: { role: true },
  });

  if (creator?.role === 'teacher') {
    if (targetType === 'school_parents') {
      throw forbidden("Un enseignant ne peut pas publier une annonce à toute l'école.");
    }
    if (targetType === 'class_parents' && targetId) {
      const assignment = await prisma.teacherAssignment.findFirst({
        where: { schoolId, teacherUserId: creatorUserId, classId: targetId },
      });
      if (!assignment) {
        throw forbidden("Vous n'êtes pas enseignant dans cette classe.");
      }
    }
    if (targetType === 'parent' && targetId) {
      const isParentOfMyStudent = await prisma.studentParent.findFirst({
        where: {
          schoolId,
          parentUserId: targetId,
          student: {
            class: {
              assignments: {
                some: { teacherUserId: creatorUserId },
              },
            },
          },
        },
      });
      if (!isParentOfMyStudent) {
        throw forbidden("Ce parent n'a pas d'élève dans vos classes.");
      }
    }
  }

  // Résoudre les ID des parents destinataires
  let parentUserIds: number[] = [];

  if (targetType === 'school_parents') {
    // Tous les parents actifs de l'école
    const parents = await prisma.user.findMany({
      where: {
        schoolId,
        role: 'parent',
        archivedAt: null,
      },
      select: { id: true },
    });
    parentUserIds = parents.map((p) => p.id);
  } else if (targetType === 'class_parents') {
    if (!targetId) {
      throw badRequest('Une classe cible doit être spécifiée');
    }
    // Tous les parents des élèves actifs de cette classe
    const studentParents = await prisma.studentParent.findMany({
      where: {
        schoolId,
        student: {
          classId: targetId,
          archivedAt: null,
        },
        parent: {
          archivedAt: null,
        },
      },
      select: { parentUserId: true },
    });
    parentUserIds = Array.from(new Set(studentParents.map((sp) => sp.parentUserId)));
  } else if (targetType === 'parent') {
    if (!targetId) {
      throw badRequest('Un parent cible doit être spécifié');
    }
    const parent = await prisma.user.findFirst({
      where: {
        id: targetId,
        schoolId,
        role: 'parent',
        archivedAt: null,
      },
    });
    if (!parent) {
      throw notFound('Parent introuvable dans cet établissement');
    }
    parentUserIds = [parent.id];
  }

  if (parentUserIds.length === 0) {
    throw badRequest('Aucun parent destinataire trouvé pour cette cible');
  }

  // Création de la notification principale
  const notification = await prisma.notification.create({
    data: {
      schoolId,
      creatorUserId,
      title,
      body,
      type,
      severity,
      targetType,
      targetId: targetId ?? null,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
    },
  });

  // Création des destinataires (bulk)
  const recipientData = parentUserIds.map((parentUserId) => ({
    schoolId,
    notificationId: notification.id,
    parentUserId,
  }));

  await prisma.notificationRecipient.createMany({
    data: recipientData,
    skipDuplicates: true,
  });

  // Émettre l'événement pour l'envoi push FCM asynchrone
  emitEvent('notification.created', { notificationId: notification.id });

  return {
    ...notification,
    recipientCount: parentUserIds.length,
  };
}

/**
 * Lister les notifications reçues par le parent connecté.
 */
export async function listNotificationsForParent(
  parentUserId: number,
  schoolId: number,
  options: { unreadOnly?: boolean; limit?: number; offset?: number } = {},
) {
  const { unreadOnly = false, limit = 20, offset = 0 } = options;

  const where = {
    schoolId,
    parentUserId,
    archivedAt: null,
    ...(unreadOnly ? { readAt: null } : {}),
  };

  const recipients = await prisma.notificationRecipient.findMany({
    where,
    include: {
      notification: {
        include: {
          creator: {
            select: {
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });

  const unreadCount = await prisma.notificationRecipient.count({
    where: {
      schoolId,
      parentUserId,
      readAt: null,
      archivedAt: null,
    },
  });

  return {
    items: recipients.map((r) => ({
      id: r.notification.id,
      recipientId: r.id,
      title: r.notification.title,
      body: r.notification.body,
      type: r.notification.type,
      severity: r.notification.severity,
      targetType: r.notification.targetType,
      resourceType: r.notification.resourceType,
      resourceId: r.notification.resourceId,
      creatorName: r.notification.creator
        ? `${r.notification.creator.firstName ?? ''} ${r.notification.creator.lastName ?? ''}`.trim()
        : 'Administration',
      creatorRole: r.notification.creator?.role ?? 'admin',
      readAt: r.readAt,
      createdAt: r.notification.createdAt,
    })),
    unreadCount,
  };
}

/**
 * Marquer une notification comme lue pour le parent connecté.
 */
export async function markNotificationAsRead(
  notificationId: number,
  parentUserId: number,
  schoolId: number,
) {
  const result = await prisma.notificationRecipient.updateMany({
    where: {
      notificationId,
      parentUserId,
      schoolId,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });
  return result.count > 0;
}

/**
 * Marquer TOUTES les notifications du parent comme lues.
 */
export async function markAllNotificationsAsRead(parentUserId: number, schoolId: number) {
  const result = await prisma.notificationRecipient.updateMany({
    where: {
      parentUserId,
      schoolId,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });
  return result.count;
}

/**
 * Lister les notifications envoyées par l'école ou l'enseignant (Admin / Enseignant).
 */
export async function listSentNotifications(
  schoolId: number,
  creatorUserId: number,
  role: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 30, offset = 0 } = options;

  const where = {
    schoolId,
    archivedAt: null,
    ...(role === 'admin' ? {} : { creatorUserId }),
  };

  const notifications = await prisma.notification.findMany({
    where,
    include: {
      creator: {
        select: { firstName: true, lastName: true, role: true },
      },
      recipients: {
        select: { id: true, readAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });

  return notifications.map((n) => {
    const totalRecipients = n.recipients.length;
    const readRecipients = n.recipients.filter((r) => r.readAt !== null).length;
    const creatorName = n.creator
      ? `${n.creator.firstName ?? ''} ${n.creator.lastName ?? ''}`.trim() || 'Utilisateur'
      : 'Administration';
    const creatorRole = n.creator?.role ?? 'admin';

    return {
      id: n.id,
      title: n.title,
      body: n.body,
      type: n.type,
      severity: n.severity,
      targetType: n.targetType,
      targetId: n.targetId,
      createdAt: n.createdAt,
      creatorName,
      creatorRole,
      stats: {
        totalRecipients,
        readRecipients,
        readPercentage: totalRecipients > 0 ? Math.round((readRecipients / totalRecipients) * 100) : 0,
      },
    };
  });
}

/**
 * Écoute l'événement notification.created et diffuse le push FCM.
 */
export function registerNotificationCreatedHandler() {
  onEvent('notification.created', async (event) => {
    const notification = await prisma.notification.findUnique({
      where: { id: event.notificationId },
      include: {
        recipients: {
          select: { parentUserId: true },
        },
      },
    });

    if (!notification || notification.archivedAt) return;

    const parentUserIds = notification.recipients.map((r) => r.parentUserId);
    if (parentUserIds.length === 0) return;

    const devices = await prisma.device.findMany({
      where: { userId: { in: parentUserIds }, user: { archivedAt: null } },
      select: { fcmToken: true },
    });

    if (devices.length === 0) return;

    const prefix =
      notification.type === 'incident'
        ? '🚨 Incident Signalé'
        : notification.type === 'convocation'
        ? '⚠️ Convocation'
        : '📢 Annonce École';

    const message = {
      title: `${prefix} : ${notification.title}`,
      body: notification.body.length > 120 ? notification.body.substring(0, 117) + '...' : notification.body,
      data: {
        notificationId: String(notification.id),
        type: notification.type,
        severity: String(notification.severity),
      },
      link: `${webAppUrl}/parent/notifications`,
    };

    const { invalidTokens } = await pushSender.send(
      devices.map((d) => d.fcmToken),
      message,
    );

    if (invalidTokens.length > 0) {
      await prisma.device.deleteMany({ where: { fcmToken: { in: invalidTokens } } });
      logger.info({ count: invalidTokens.length }, 'Tokens FCM invalides purgés suite à notification');
    }
  });
}

/**
 * Notifications push aux parents lors de la création/modification d'une note.
 */
export function registerNotificationHandlers() {
  onEvent('grade.created', (event) => notifyParents(event, 'nouvelle'));
  onEvent('grade.updated', (event) => notifyParents(event, 'modifiee'));
  onEvent('attendance.marked', (event) => notifyParentsOfAttendance(event));
}

/** Exporté pour être testable directement, sans dépendre du timing du bus. */
export async function notifyParents(event: GradeEvent, kind: 'nouvelle' | 'modifiee') {
  const grade = await prisma.grade.findUnique({
    where: { id: event.gradeId },
    include: {
      subject: { select: { name: true } },
      gradeType: { select: { label: true } },
      evaluation: { select: { label: true } },
      student: {
        select: {
          firstName: true,
          lastName: true,
          archivedAt: true,
          parents: { select: { parentUserId: true } },
        },
      },
    },
  });

  if (!grade || grade.student.archivedAt) return;

  const parentIds = grade.student.parents.map((p) => p.parentUserId);
  if (parentIds.length === 0) return;

  const devices = await prisma.device.findMany({
    where: { userId: { in: parentIds }, user: { archivedAt: null } },
    select: { fcmToken: true },
  });
  if (devices.length === 0) return;

  const title =
    kind === 'nouvelle'
      ? `${grade.student.firstName} a une nouvelle note`
      : `${grade.student.firstName} a une note modifiée`;

  const message = {
    title,
    body: `${grade.subject.name} · ${grade.evaluation.label} : ${Number(grade.value)}/${Number(grade.maxValue)}`,
    data: {
      gradeId: String(grade.id),
      studentId: String(grade.studentId),
      termId: String(grade.termId),
    },
    link: `${webAppUrl}/parent/notes/${grade.id}`,
  };

  const { invalidTokens } = await pushSender.send(
    devices.map((d) => d.fcmToken),
    message,
  );

  if (invalidTokens.length > 0) {
    await prisma.device.deleteMany({ where: { fcmToken: { in: invalidTokens } } });
    logger.info({ count: invalidTokens.length }, 'Tokens FCM invalides purgés');
  }
}

/**
 * Prévient les parents d'une absence ou d'un retard.
 */
export async function notifyParentsOfAttendance(event: AttendanceEvent) {
  const attendance = await prisma.attendance.findUnique({
    where: { id: event.attendanceId },
    include: {
      student: {
        select: {
          firstName: true,
          lastName: true,
          archivedAt: true,
          parents: { select: { parentUserId: true } },
        },
      },
      class: { select: { name: true } },
      slot: {
        select: {
          startMinute: true,
          endMinute: true,
          teacherAssignment: { select: { subject: { select: { name: true } } } },
        },
      },
    },
  });

  if (!attendance || attendance.student.archivedAt) return;

  const parentIds = attendance.student.parents.map((p) => p.parentUserId);
  if (parentIds.length === 0) return;

  const devices = await prisma.device.findMany({
    where: { userId: { in: parentIds }, user: { archivedAt: null } },
    select: { fcmToken: true },
  });
  if (devices.length === 0) return;

  const when = attendance.slot
    ? `en ${attendance.slot.teacherAssignment.subject.name} (${minutesToHHMM(attendance.slot.startMinute)}-${minutesToHHMM(attendance.slot.endMinute)})`
    : "aujourd'hui";
  const title =
    attendance.status === 'absent'
      ? `${attendance.student.firstName} était absent(e) ${when}`
      : `${attendance.student.firstName} est arrivé(e) en retard ${when}`;

  const message = {
    title,
    body: `${attendance.class.name} · ${attendance.date.toLocaleDateString('fr-FR')}`,
    data: {
      attendanceId: String(attendance.id),
      studentId: String(attendance.studentId),
      classId: String(attendance.classId),
    },
    link: `${webAppUrl}/parent/presence/${attendance.id}`,
  };

  const { invalidTokens } = await pushSender.send(
    devices.map((d) => d.fcmToken),
    message,
  );

  if (invalidTokens.length > 0) {
    await prisma.device.deleteMany({ where: { fcmToken: { in: invalidTokens } } });
    logger.info({ count: invalidTokens.length }, 'Tokens FCM invalides purgés');
  }
}

/** Enregistre un appareil pour l'utilisateur connecté. Idempotent. */
export async function registerDevice(userId: number, fcmToken: string) {
  const existing = await prisma.device.findUnique({ where: { fcmToken } });

  if (existing) {
    if (existing.userId === userId) return existing;
    return prisma.device.update({ where: { fcmToken }, data: { userId } });
  }

  return prisma.device.create({ data: { userId, fcmToken } });
}

export async function removeDevice(userId: number, fcmToken: string) {
  const { count } = await prisma.device.deleteMany({ where: { userId, fcmToken } });
  return count > 0;
}

export function listDevices(userId: number) {
  return prisma.device.findMany({
    where: { userId },
    select: { id: true, fcmToken: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
}
