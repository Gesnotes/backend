import prisma from '../lib/prisma';
import type { AttendanceEvent, GradeEvent } from '../lib/events';
import { logger } from '../lib/logger';
import { webAppUrl } from '../lib/env';
import { onEvent } from '../lib/events';
import { pushSender } from '../lib/push';

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

  const title =
    kind === 'nouvelle'
      ? `Nouvelle note en ${grade.subject.name}`
      : `Note modifiée en ${grade.subject.name}`;

  const message = {
    title,
    // L'intitulé de l'évaluation (« Interro du 12/09 ») est plus parlant pour
    // la famille que le seul type ; on garde le type entre parenthèses.
    body: `${grade.student.firstName} · ${grade.evaluation.label} : ${Number(grade.value)}/${Number(grade.maxValue)} (${grade.gradeType.label})`,
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

  const title = attendance.status === 'absent' ? 'Absence signalée' : 'Retard signalé';

  const message = {
    title,
    body: `${attendance.student.firstName} a été marqué(e) ${attendance.status === 'absent' ? 'absent(e)' : 'en retard'} aujourd'hui.`,
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
