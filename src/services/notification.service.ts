import prisma from '../lib/prisma';
import type { AttendanceEvent, GradeEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { webAppUrl } from '../lib/env';
import { onEvent } from '../lib/events';
import { pushSender } from '../lib/push';
import { minutesToHHMM } from './schedule.service';

/**
 * Notifications push aux parents.
 *
 * Branché sur les événements du lot 9, jamais appelé depuis un contrôleur :
 * l'envoi se fait hors du cycle requête/réponse. Un FCM indisponible ne doit
 * ni faire échouer ni ralentir la saisie d'une note par un enseignant.
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

  // Le nom de l'enfant en tête : un parent qui suit plusieurs enfants doit
  // le reconnaître sans ouvrir la notification.
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
    // Ouvre directement la note concernée dans l'application web.
    link: `${webAppUrl}/parent/notes/${grade.id}`,
  };

  const { invalidTokens } = await pushSender.send(
    devices.map((d) => d.fcmToken),
    message,
  );

  // Un appareil désinstallé garderait sinon une ligne morte pour toujours, et
  // chaque envoi futur repaierait son échec.
  if (invalidTokens.length > 0) {
    await prisma.device.deleteMany({ where: { fcmToken: { in: invalidTokens } } });
    logger.info({ count: invalidTokens.length }, 'Tokens FCM invalides purgés');
  }
}

/**
 * Prévient les parents d'une absence ou d'un retard, jamais d'une présence.
 * Exportée pour être testable directement, sans dépendre du timing du bus.
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

  // Le nom de l'enfant en tête, un ton neutre plutôt qu'une alerte : une
  // absence est une information pour la famille, pas une urgence. Sur une
  // classe mode `notes`, on précise la matière et l'horaire : sans ça, deux
  // absences le même jour (deux créneaux différents) produiraient deux
  // notifications identiques, indiscernables l'une de l'autre.
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

  // Un même appareil peut changer de main (téléphone partagé, réinstallation) :
  // le token est réattribué plutôt que rejeté en doublon.
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
