import { Prisma } from '../generated/prisma/client';

import prisma from '../lib/prisma';
import { conflict, notFound } from '../errors/AppError';
import { identityFields } from './userFields';

/**
 * Toutes les fonctions prennent `schoolId` en premier argument et le placent
 * dans le `where`, y compris pour les accès par identifiant : sans cela, un id
 * deviné traverserait les écoles.
 */

export async function listSubjects(schoolId: number, includeArchived = false) {
  const subjects = await prisma.subject.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { name: 'asc' },
    include: {
      coefficients: { include: { class: { select: { id: true, name: true, level: true } } } },
      assignments: {
        where: { teacher: { archivedAt: null } },
        include: {
          // Identité seule : cette liste sert à savoir qui enseigne quoi, pas
          // à diffuser l'annuaire des adresses de l'équipe. L'administration
          // dispose de /teachers pour cela.
          teacher: { select: identityFields },
          class: { select: { id: true, name: true } },
        },
      },
    },
  });

  return subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    coefficient: subject.coefficient, // défaut école
    archivedAt: subject.archivedAt,
    coefficientsParClasse: subject.coefficients.map((c) => ({
      classId: c.classId,
      className: c.class.name,
      level: c.class.level,
      coefficient: c.coefficient,
    })),
    enseignants: subject.assignments.map((a) => ({
      id: a.teacher.id,
      firstName: a.teacher.firstName,
      lastName: a.teacher.lastName,
      classId: a.classId,
      className: a.class.name,
    })),
  }));
}

export async function getSubject(schoolId: number, id: number) {
  const subject = await prisma.subject.findFirst({ where: { id, schoolId } });
  if (!subject) throw notFound('Matière introuvable');
  return subject;
}

export function createSubject(
  schoolId: number,
  data: { name: string; coefficient?: number },
) {
  return prisma.subject.create({
    data: { schoolId, name: data.name, coefficient: data.coefficient ?? 1 },
  });
}

export async function updateSubject(
  schoolId: number,
  id: number,
  data: { name?: string; coefficient?: number },
) {
  await getSubject(schoolId, id); // garantit l'appartenance à l'école
  return prisma.subject.update({ where: { id }, data });
}

/**
 * Archivage par défaut : les notes déjà saisies dans cette matière restent
 * lisibles et continuent de compter dans les bulletins passés.
 *
 * `permanent` supprime physiquement, et seulement si aucune note n'existe :
 * une suppression en cascade effacerait silencieusement des notes d'élèves.
 */
export async function deleteSubject(schoolId: number, id: number, permanent: boolean) {
  await getSubject(schoolId, id);

  if (!permanent) {
    return prisma.subject.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  const gradeCount = await prisma.grade.count({ where: { subjectId: id } });
  if (gradeCount > 0) {
    throw conflict(
      `Suppression impossible : ${gradeCount} note(s) sont rattachées à cette matière. Archivez-la plutôt.`,
      { gradeCount },
    );
  }

  return prisma.subject.delete({ where: { id } });
}

export async function restoreSubject(schoolId: number, id: number) {
  await getSubject(schoolId, id);
  return prisma.subject.update({ where: { id }, data: { archivedAt: null } });
}

/**
 * Coefficient d'une matière pour une classe donnée (plan §2.4, couche 1).
 *
 * La classe est vérifiée dans la même école : sans cela, un admin pourrait
 * poser un coefficient sur la classe d'un autre établissement.
 */
export async function setSubjectCoefficient(
  schoolId: number,
  subjectId: number,
  classId: number,
  coefficient: number,
) {
  await getSubject(schoolId, subjectId);

  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId } });
  if (!klass) throw notFound('Classe introuvable');

  return prisma.subjectCoefficient.upsert({
    where: { subjectId_classId: { subjectId, classId } },
    update: { coefficient },
    create: { subjectId, classId, coefficient },
  });
}

/** Retire la surcharge : la matière retombe sur le coefficient de l'école. */
export async function removeSubjectCoefficient(
  schoolId: number,
  subjectId: number,
  classId: number,
) {
  await getSubject(schoolId, subjectId);

  const { count } = await prisma.subjectCoefficient.deleteMany({ where: { subjectId, classId } });
  if (count === 0) throw notFound('Aucun coefficient défini pour cette classe');
}

/**
 * Résolution du coefficient effectif (plan §2.4) : surcharge de classe, sinon
 * défaut de l'école, sinon 1. Exposé ici pour que le lot 6 s'appuie sur une
 * seule implémentation.
 */
export async function resolveSubjectCoefficient(
  subjectId: number,
  classId: number,
): Promise<Prisma.Decimal> {
  const override = await prisma.subjectCoefficient.findUnique({
    where: { subjectId_classId: { subjectId, classId } },
  });
  if (override) return override.coefficient;

  const subject = await prisma.subject.findUniqueOrThrow({ where: { id: subjectId } });
  return subject.coefficient ?? new Prisma.Decimal(1);
}
