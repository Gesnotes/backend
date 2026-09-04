import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { createNotification } from './notification.service';

/**
 * Nombre de jours avant une évaluation programmée où son rappel part aux
 * parents — un seul rappel, pas une fenêtre (« exactement J-3 », pas
 * « à partir de J-3 »).
 */
const REMINDER_DAYS_BEFORE = 3;

/**
 * Rappel push aux parents pour chaque évaluation programmée dans exactement
 * `REMINDER_DAYS_BEFORE` jours, une fois par évaluation (`reminderSentAt`).
 * Pensé pour tourner une fois par jour (voir `src/index.ts`) ; chaque échec
 * individuel (ex. classe sans parent lié) est isolé, il ne doit jamais faire
 * échouer les autres évaluations du même lot.
 */
export async function sendEvaluationReminders(): Promise<{ sent: number; failed: number }> {
  const target = new Date();
  target.setDate(target.getDate() + REMINDER_DAYS_BEFORE);
  target.setHours(0, 0, 0, 0);

  const evaluations = await prisma.evaluation.findMany({
    where: { date: target, reminderSentAt: null, class: { archivedAt: null } },
    include: {
      class: { select: { name: true } },
      subject: { select: { name: true } },
      gradeType: { select: { label: true } },
    },
  });

  let sent = 0;
  let failed = 0;

  for (const evaluation of evaluations) {
    try {
      const creatorUserId =
        evaluation.teacherUserId ??
        (
          await prisma.user.findFirst({
            where: { schoolId: evaluation.schoolId, role: 'admin', archivedAt: null },
            select: { id: true },
          })
        )?.id;

      if (!creatorUserId) {
        failed++;
        continue;
      }

      await createNotification({
        schoolId: evaluation.schoolId,
        creatorUserId,
        title: `${evaluation.gradeType.label} à venir`,
        body: `${evaluation.subject.name} (${evaluation.class.name}) — ${evaluation.label}, dans ${REMINDER_DAYS_BEFORE} jours.`,
        type: 'rappel',
        severity: 0,
        targetType: 'class_parents',
        targetId: evaluation.classId,
        resourceType: 'evaluation',
        resourceId: evaluation.id,
      });

      await prisma.evaluation.update({
        where: { id: evaluation.id },
        data: { reminderSentAt: new Date() },
      });

      sent++;
    } catch (cause) {
      failed++;
      logger.error({ err: cause, evaluationId: evaluation.id }, "Échec du rappel d'évaluation");
    }
  }

  return { sent, failed };
}
