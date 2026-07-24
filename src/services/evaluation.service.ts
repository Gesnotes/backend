import { Prisma } from '../generated/prisma/client';

import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, notFound } from '../errors/AppError';
import { assertCanGrade, assertContext } from './grade.service';

/**
 * Évaluations : une interrogation, un devoir, une composition **concrets**.
 *
 * C'est le niveau qui manquait pour saisir plusieurs notes du même type dans
 * une même période. Une évaluation porte son libellé, sa date et son barème ;
 * le poids, lui, reste sur le type de note (source de vérité unique). Toute la
 * saisie de notes passe désormais par une évaluation.
 */

const gradeTypeSelect = {
  select: { id: true, code: true, label: true, weight: true },
} as const;

type EvaluationRow = {
  id: number;
  classId: number;
  subjectId: number;
  gradeTypeId: number;
  termId: number;
  teacherUserId: number | null;
  label: string;
  date: Date | null;
  maxValue: Prisma.Decimal;
  createdAt: Date | null;
  gradeType: { id: number; code: string; label: string; weight: Prisma.Decimal };
  _count?: { grades: number };
};

function toPublicEvaluation(evaluation: EvaluationRow) {
  return {
    id: evaluation.id,
    classId: evaluation.classId,
    subjectId: evaluation.subjectId,
    termId: evaluation.termId,
    teacherUserId: evaluation.teacherUserId,
    label: evaluation.label,
    date: evaluation.date,
    maxValue: Number(evaluation.maxValue),
    createdAt: evaluation.createdAt,
    gradedCount: evaluation._count?.grades ?? 0,
    type: {
      id: evaluation.gradeType.id,
      code: evaluation.gradeType.code,
      label: evaluation.gradeType.label,
      weight: Number(evaluation.gradeType.weight),
    },
  };
}

/**
 * Le barème est stocké en `Decimal(5,2)` : il doit tenir sous 1000, sinon
 * PostgreSQL renvoie un « numeric field overflow » (500 illisible) au lieu
 * d'un refus clair. Un barème d'école ne dépasse de toute façon jamais 999.
 */
function assertBareme(maxValue: number) {
  if (!Number.isFinite(maxValue) || maxValue <= 0 || maxValue > 999) {
    throw badRequest('Le barème doit être un nombre compris entre 1 et 999');
  }
}

/** Évaluations d'un couple classe × matière pour une période, les plus récentes d'abord. */
export async function listEvaluations(
  auth: AuthPayload,
  filters: { classId: number; subjectId: number; termId: number },
) {
  await assertCanGrade(auth, filters.classId, filters.subjectId);

  const evaluations = await prisma.evaluation.findMany({
    where: {
      schoolId: auth.schoolId,
      classId: filters.classId,
      subjectId: filters.subjectId,
      termId: filters.termId,
    },
    // La date porte le sens métier (l'ordre des contrôles) ; à défaut, l'ordre
    // de création. Les plus récentes en tête, comme l'historique.
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    include: { gradeType: gradeTypeSelect, _count: { select: { grades: true } } },
  });

  return evaluations.map(toPublicEvaluation);
}

export async function createEvaluation(
  auth: AuthPayload,
  data: {
    classId: number;
    subjectId: number;
    gradeTypeId: number;
    termId: number;
    label: string;
    date?: string | null;
    maxValue?: number;
  },
) {
  await assertCanGrade(auth, data.classId, data.subjectId);
  await assertContext(auth.schoolId, data.gradeTypeId, data.termId);

  const maxValue = data.maxValue ?? 20;
  assertBareme(maxValue);

  const evaluation = await prisma.evaluation.create({
    data: {
      schoolId: auth.schoolId,
      classId: data.classId,
      subjectId: data.subjectId,
      gradeTypeId: data.gradeTypeId,
      termId: data.termId,
      teacherUserId: auth.userId,
      label: data.label.trim(),
      date: data.date ? new Date(data.date) : null,
      maxValue,
    },
    include: { gradeType: gradeTypeSelect, _count: { select: { grades: true } } },
  });

  return toPublicEvaluation(evaluation);
}

export async function updateEvaluation(
  auth: AuthPayload,
  id: number,
  data: { label?: string; date?: string | null; maxValue?: number },
) {
  const evaluation = await findEvaluationForWrite(auth, id);

  const nextMax = data.maxValue;
  const maxChanged = nextMax !== undefined && nextMax !== Number(evaluation.maxValue);

  if (nextMax !== undefined) assertBareme(nextMax);

  // Changer le barème d'une évaluation déjà notée ne doit pas laisser des notes
  // au-dessus du nouveau maximum : on refuse plutôt que de tronquer en silence.
  if (maxChanged) {
    const over = await prisma.grade.count({
      where: { evaluationId: id, value: { gt: nextMax } },
    });
    if (over > 0) {
      throw badRequest(
        `${over} note(s) dépassent le nouveau barème de ${nextMax}. Corrigez-les d'abord.`,
        { over, maxValue: nextMax },
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.evaluation.update({
      where: { id },
      data: {
        ...(data.label !== undefined ? { label: data.label.trim() } : {}),
        ...(data.date !== undefined ? { date: data.date ? new Date(data.date) : null } : {}),
        ...(nextMax !== undefined ? { maxValue: nextMax } : {}),
      },
      include: { gradeType: gradeTypeSelect, _count: { select: { grades: true } } },
    });

    // Le barème est recopié sur chaque note (dénormalisation lue par le calcul
    // des moyennes) : il faut le propager en même temps.
    if (maxChanged) {
      await tx.grade.updateMany({ where: { evaluationId: id }, data: { maxValue: nextMax } });
    }

    return result;
  });

  return toPublicEvaluation(updated);
}

/** Supprime l'évaluation et, en cascade, ses notes. */
export async function deleteEvaluation(auth: AuthPayload, id: number) {
  await findEvaluationForWrite(auth, id);
  await prisma.evaluation.delete({ where: { id } });
}

/**
 * Charge une évaluation en vérifiant que l'appelant a le droit d'y toucher.
 * Point de passage obligé de PATCH et DELETE.
 */
async function findEvaluationForWrite(auth: AuthPayload, id: number) {
  const evaluation = await prisma.evaluation.findFirst({
    where: { id, schoolId: auth.schoolId },
  });
  if (!evaluation) throw notFound('Évaluation introuvable');

  await assertCanGrade(auth, evaluation.classId, evaluation.subjectId);

  return evaluation;
}
