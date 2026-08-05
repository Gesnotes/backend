import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, notFound } from '../errors/AppError';
import { emitEvent } from '../lib/events';
import { assertCanGrade, assertTermOpen } from './grade.service';

/**
 * Saisie d'une évaluation pour toute une classe, en une requête.
 *
 * Le geste réel d'un enseignant n'est pas « créer une note » mais « saisir la
 * composition du trimestre pour mes trente-quatre élèves ». Le faire note par
 * note imposait trente-quatre requêtes, dont certaines pouvaient échouer au
 * milieu : l'enseignant se retrouvait avec une saisie à moitié enregistrée,
 * sans savoir laquelle.
 *
 * L'opération est donc **idempotente** et porte sur une **évaluation** :
 * rejouer exactement le même lot ne crée pas de doublon, il réécrit les mêmes
 * valeurs. C'est ce qui permet au client de réémettre sans risque une saisie
 * partie hors connexion. L'évaluation portant elle-même la matière, le type,
 * la période et le barème, plusieurs évaluations du même type coexistent sans
 * ambiguïté — ce qui n'était pas possible quand l'identité d'une note était son
 * type.
 */

export interface BatchEntry {
  studentId: number;
  /** `null` supprime la note de cet élève pour l'évaluation visée. */
  value: number | null;
  comment?: string | null;
}

export interface BatchInput {
  evaluationId: number;
  entries: BatchEntry[];
}

export type SkipReason = 'eleve_hors_classe';

export interface BatchResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Élèves volontairement laissés de côté, avec le motif. */
  skipped: { studentId: number; reason: SkipReason }[];
}

export async function saveGradeBatch(auth: AuthPayload, input: BatchInput): Promise<BatchResult> {
  const evaluation = await prisma.evaluation.findFirst({
    where: { id: input.evaluationId, schoolId: auth.schoolId },
  });
  if (!evaluation) throw notFound('Évaluation introuvable');

  await assertCanGrade(auth, evaluation.classId, evaluation.subjectId);
  await assertTermOpen(auth, evaluation.termId);

  const maxValue = Number(evaluation.maxValue);

  /**
   * Un même élève envoyé deux fois dans le lot rendrait le résultat dépendant
   * de l'ordre d'application. Refusé d'emblée plutôt qu'arbitré en silence.
   */
  const seen = new Set<number>();
  for (const entry of input.entries) {
    if (seen.has(entry.studentId)) {
      throw badRequest('Le même élève apparaît deux fois dans cette saisie.', {
        studentId: entry.studentId,
      });
    }
    seen.add(entry.studentId);
  }

  /**
   * Validation des valeurs **avant** toute écriture : une note hors barème au
   * milieu du lot ne doit pas laisser derrière elle vingt notes enregistrées
   * et quatorze perdues.
   */
  const outOfRange = input.entries.filter(
    (entry) => entry.value !== null && (entry.value < 0 || entry.value > maxValue),
  );
  if (outOfRange.length > 0) {
    throw badRequest(`Toutes les notes doivent être comprises entre 0 et ${maxValue}.`, {
      studentIds: outOfRange.map((entry) => entry.studentId),
    });
  }

  // Les élèves archivés sont exclus : ils ne figurent plus dans la classe.
  const students = await prisma.student.findMany({
    where: {
      id: { in: [...seen] },
      classId: evaluation.classId,
      schoolId: auth.schoolId,
      archivedAt: null,
    },
    select: { id: true },
  });
  const validIds = new Set(students.map((student) => student.id));

  // Une note par élève et par évaluation (contrainte d'unicité) : un simple
  // Map suffit, plus aucune ambiguïté « plusieurs notes du même type ».
  const existing = await prisma.grade.findMany({
    where: { evaluationId: evaluation.id, studentId: { in: [...validIds] } },
    select: { id: true, studentId: true, value: true, maxValue: true, comment: true },
  });
  const byStudent = new Map(existing.map((grade) => [grade.studentId, grade]));

  const skipped: BatchResult['skipped'] = [];
  const toCreate: BatchEntry[] = [];
  const toUpdate: { id: number; entry: BatchEntry }[] = [];
  const toDelete: number[] = [];
  let unchanged = 0;

  for (const entry of input.entries) {
    if (!validIds.has(entry.studentId)) {
      skipped.push({ studentId: entry.studentId, reason: 'eleve_hors_classe' });
      continue;
    }

    const grade = byStudent.get(entry.studentId);

    if (entry.value === null) {
      if (grade) toDelete.push(grade.id);
      continue;
    }

    if (!grade) {
      toCreate.push(entry);
      continue;
    }

    const comment = entry.comment === undefined ? grade.comment : (entry.comment || null);
    const identical =
      Number(grade.value) === entry.value &&
      Number(grade.maxValue) === maxValue &&
      grade.comment === comment;

    // Rejouer le même lot ne doit ni réécrire en base ni renotifier les
    // familles : c'est ce qui rend l'opération sûre à réémettre hors connexion.
    if (identical) unchanged += 1;
    else toUpdate.push({ id: grade.id, entry });
  }

  const created = await prisma.$transaction(async (tx) => {
    if (toDelete.length > 0) {
      await tx.grade.deleteMany({ where: { id: { in: toDelete } } });
    }

    for (const { id, entry } of toUpdate) {
      await tx.grade.update({
        where: { id },
        data: {
          value: entry.value as number,
          maxValue,
          ...(entry.comment !== undefined ? { comment: entry.comment || null } : {}),
        },
      });
    }

    const inserted: { id: number; studentId: number }[] = [];
    for (const entry of toCreate) {
      const grade = await tx.grade.create({
        data: {
          schoolId: auth.schoolId,
          studentId: entry.studentId,
          evaluationId: evaluation.id,
          subjectId: evaluation.subjectId,
          gradeTypeId: evaluation.gradeTypeId,
          termId: evaluation.termId,
          teacherUserId: auth.userId,
          value: entry.value as number,
          maxValue,
          comment: entry.comment || null,
        },
        select: { id: true, studentId: true },
      });
      inserted.push(grade);
    }

    return inserted;
  });

  // Notifications émises après le commit : une transaction annulée ne doit pas
  // laisser partir un message annonçant une note qui n'existe pas.
  for (const grade of created) {
    emitEvent('grade.created', {
      gradeId: grade.id,
      schoolId: auth.schoolId,
      studentId: grade.studentId,
      subjectId: evaluation.subjectId,
      termId: evaluation.termId,
    });
  }
  for (const { id, entry } of toUpdate) {
    emitEvent('grade.updated', {
      gradeId: id,
      schoolId: auth.schoolId,
      studentId: entry.studentId,
      subjectId: evaluation.subjectId,
      termId: evaluation.termId,
    });
  }

  return {
    created: created.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    unchanged,
    skipped,
  };
}
