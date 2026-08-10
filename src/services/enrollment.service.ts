import prisma from '../lib/prisma';
import type { EnrollmentDecisionType } from '../generated/prisma/enums';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, notFound } from '../errors/AppError';

/**
 * Réinscription : déplacer en un lot les élèves d'une classe vers la classe
 * suivante (promotion, redoublement, ou tout autre choix de l'administration),
 * à la préparation d'une rentrée. `Class.promotesToId` (lot 3) donne la cible
 * par défaut d'une promotion normale, mais l'administration reste libre de
 * viser une autre classe pour n'importe quel élève.
 *
 * Chaque déplacement laisse une trace dans `EnrollmentDecision` : un
 * directeur doit pouvoir retrouver, un an après, qui a redoublé et vers où
 * chacun est parti — l'historique des notes ne le dit pas, une classe n'ancre
 * jamais rétroactivement une note passée.
 */

export interface EnrollmentEntry {
  studentId: number;
  toClassId: number;
  decision: EnrollmentDecisionType;
}

export type EnrollmentSkipReason = 'eleve_hors_classe';

export interface EnrollmentResult {
  moved: number;
  skipped: { studentId: number; reason: EnrollmentSkipReason }[];
}

export async function reinscrireEleves(
  auth: AuthPayload,
  fromClassId: number,
  entries: EnrollmentEntry[],
): Promise<EnrollmentResult> {
  const fromClass = await prisma.class.findFirst({
    where: { id: fromClassId, schoolId: auth.schoolId },
  });
  if (!fromClass) throw notFound('Classe introuvable');

  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.studentId)) {
      throw badRequest('Le même élève apparaît deux fois dans cette saisie.', {
        studentId: entry.studentId,
      });
    }
    seen.add(entry.studentId);
  }

  // Cible archivée distinguée d'une cible inexistante : une classe qu'on
  // vient de ranger n'est pas « introuvable », mais y inscrire des élèves les
  // ferait disparaître des listes courantes sans que personne ne le sache.
  const toClassIds = [...new Set(entries.map((entry) => entry.toClassId))];
  const targets = await prisma.class.findMany({
    where: { id: { in: toClassIds }, schoolId: auth.schoolId },
    select: { id: true, name: true, archivedAt: true },
  });
  const targetsById = new Map(targets.map((target) => [target.id, target]));
  for (const classId of toClassIds) {
    const target = targetsById.get(classId);
    if (!target) throw notFound('Classe de destination introuvable');
    if (target.archivedAt) {
      throw conflict(
        `« ${target.name} » est archivée : restaurez-la avant d'y inscrire des élèves.`,
        { classId: target.id },
      );
    }
  }

  // Seuls les élèves actuellement dans la classe source peuvent en partir :
  // un élève déjà déplacé entre-temps n'y figure plus.
  const students = await prisma.student.findMany({
    where: { id: { in: [...seen] }, classId: fromClassId, schoolId: auth.schoolId, archivedAt: null },
    select: { id: true },
  });
  const validIds = new Set(students.map((student) => student.id));

  const skipped: EnrollmentResult['skipped'] = [];
  const toApply: EnrollmentEntry[] = [];
  for (const entry of entries) {
    if (!validIds.has(entry.studentId)) {
      skipped.push({ studentId: entry.studentId, reason: 'eleve_hors_classe' });
      continue;
    }
    toApply.push(entry);
  }

  await prisma.$transaction(async (tx) => {
    for (const entry of toApply) {
      await tx.student.update({ where: { id: entry.studentId }, data: { classId: entry.toClassId } });
      await tx.enrollmentDecision.create({
        data: {
          schoolId: auth.schoolId,
          studentId: entry.studentId,
          fromClassId,
          toClassId: entry.toClassId,
          decision: entry.decision,
          decidedByUserId: auth.userId,
        },
      });
    }
  });

  return { moved: toApply.length, skipped };
}

/** Historique des réinscriptions décidées depuis cette classe, les plus récentes d'abord. */
export async function listEnrollmentDecisions(auth: AuthPayload, fromClassId: number) {
  const fromClass = await prisma.class.findFirst({
    where: { id: fromClassId, schoolId: auth.schoolId },
  });
  if (!fromClass) throw notFound('Classe introuvable');

  const decisions = await prisma.enrollmentDecision.findMany({
    where: { fromClassId, schoolId: auth.schoolId },
    orderBy: { createdAt: 'desc' },
    include: {
      student: { select: { id: true, firstName: true, lastName: true } },
      toClass: { select: { id: true, name: true, level: true } },
    },
  });

  return decisions.map((decision) => ({
    id: decision.id,
    decision: decision.decision,
    createdAt: decision.createdAt,
    student: decision.student,
    toClass: decision.toClass,
  }));
}
