import { Prisma } from '../generated/prisma/client';

import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { labelKey } from '../lib/normalize';
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

/**
 * Refuse un nom déjà porté par une autre matière de l'école.
 *
 * La comparaison ignore casse et accents : « Mathématiques » et
 * « Mathematiques » ne doivent pas coexister. Les matières archivées comptent
 * dans le contrôle — sinon on recréerait un doublon d'une matière simplement
 * mise de côté, et la restaurer produirait le doublon qu'on voulait éviter.
 *
 * `exceptId` exclut la matière en cours de modification.
 */
async function assertNameAvailable(schoolId: number, name: string, exceptId?: number) {
  const key = labelKey(name);
  const siblings = await prisma.subject.findMany({
    where: { schoolId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, archivedAt: true },
  });

  const clash = siblings.find((subject) => labelKey(subject.name) === key);
  if (clash) {
    throw conflict(
      clash.archivedAt
        ? `Une matière archivée porte déjà ce nom (« ${clash.name} »). Restaurez-la plutôt que d'en créer une nouvelle.`
        : `La matière « ${clash.name} » existe déjà.`,
      { subjectId: clash.id, archived: clash.archivedAt !== null },
    );
  }
}

export async function createSubject(
  schoolId: number,
  data: { name: string; coefficient?: number },
) {
  const name = data.name.trim();
  await assertNameAvailable(schoolId, name);

  return prisma.subject.create({
    data: { schoolId, name, coefficient: data.coefficient ?? 1 },
  });
}

export async function updateSubject(
  schoolId: number,
  id: number,
  data: { name?: string; coefficient?: number },
) {
  await getSubject(schoolId, id); // garantit l'appartenance à l'école
  if (data.name !== undefined) await assertNameAvailable(schoolId, data.name.trim(), id);

  return prisma.subject.update({
    where: { id },
    data: { ...data, ...(data.name !== undefined ? { name: data.name.trim() } : {}) },
  });
}

/**
 * Archivage par défaut : les notes déjà saisies dans cette matière restent
 * lisibles et continuent de compter dans les bulletins passés.
 *
 * `permanent` supprime physiquement, réservé à une matière déjà archivée
 * avec retapage du nom exact — même garde-fou que pour une période ou une
 * année scolaire (voir `term.service.ts`) — et emporte en cascade ses
 * évaluations et ses notes.
 */
export async function deleteSubject(
  schoolId: number,
  id: number,
  permanent: boolean,
  expectedName = '',
) {
  const subject = await getSubject(schoolId, id);

  if (!permanent) {
    return prisma.subject.update({ where: { id }, data: { archivedAt: new Date() } });
  }

  if (!subject.archivedAt) {
    throw conflict('Archivez la matière avant de la supprimer définitivement.', { subjectId: id });
  }

  if (expectedName.trim().toLowerCase() !== subject.name.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au nom de la matière. Cette suppression est définitive.',
      { attendu: subject.name },
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
 *
 * `schoolId` scope les deux requêtes explicitement — sans lui, un appelant
 * pourrait lire le coefficient/la matière d'une autre école en devinant un
 * identifiant, la relation `subjectId`/`classId` seule ne suffisant pas à
 * garantir l'isolation entre écoles (voir CLAUDE.md).
 */
export async function resolveSubjectCoefficient(
  schoolId: number,
  subjectId: number,
  classId: number,
): Promise<Prisma.Decimal> {
  const override = await prisma.subjectCoefficient.findFirst({
    where: { subjectId, classId, subject: { schoolId } },
  });
  if (override) return override.coefficient;

  const subject = await prisma.subject.findFirst({ where: { id: subjectId, schoolId } });
  if (!subject) throw notFound('Matière introuvable');
  return subject.coefficient ?? new Prisma.Decimal(1);
}
