import crypto from 'node:crypto';
import argon2 from 'argon2';

import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { revokeAllSessions } from './auth.service';
import { sendInvitation } from './invitation.service';

export { sendInvitation };

export interface AssignmentInput {
  classId: number;
  subjectId: number;
}

/** Champs exposés par l'API : jamais `passwordHash`. */
const publicFields = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
  archivedAt: true,
  createdAt: true,
} as const;

export async function listTeachers(schoolId: number, includeArchived = false) {
  const teachers = await prisma.user.findMany({
    where: { schoolId, role: 'teacher', ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ lastName: 'asc' }, { email: 'asc' }],
    select: {
      ...publicFields,
      assignments: {
        include: {
          class: { select: { id: true, name: true, level: true } },
          subject: { select: { id: true, name: true } },
        },
      },
    },
  });

  return teachers.map(({ assignments, ...teacher }) => ({
    ...teacher,
    affectations: assignments.map((a) => ({
      id: a.id,
      classId: a.classId,
      className: a.class.name,
      level: a.class.level,
      subjectId: a.subjectId,
      subjectName: a.subject.name,
    })),
  }));
}

export async function getTeacher(schoolId: number, id: number) {
  const teacher = await prisma.user.findFirst({
    where: { id, schoolId, role: 'teacher' },
    select: publicFields,
  });
  if (!teacher) throw notFound('Enseignant introuvable');
  return teacher;
}

/**
 * Crée le compte enseignant et ses affectations dans une seule transaction :
 * un compte sans affectation ou des affectations orphelines seraient des états
 * intermédiaires invalides.
 *
 * Aucun mot de passe n'est transmis par l'API. Le compte est créé avec un
 * secret aléatoire inutilisable, et l'enseignant reçoit un lien d'invitation
 * pour définir le sien — le même mécanisme que la réinitialisation.
 */
export async function createTeacher(
  schoolId: number,
  data: {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    assignments?: AssignmentInput[];
  },
) {
  const email = normalizeEmail(data.email);
  const phone = data.phone ? normalizePhone(data.phone) : null;

  await assertAssignmentsBelongToSchool(schoolId, data.assignments ?? []);

  const existing = await prisma.user.findFirst({ where: { schoolId, email } });
  if (existing) throw conflict('Cette adresse email est déjà utilisée par un autre compte de l’établissement.');

  const teacher = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        schoolId,
        email,
        phone,
        role: 'teacher',
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        // Secret aléatoire : le compte n'est utilisable qu'après invitation.
        passwordHash: await argon2.hash(crypto.randomBytes(32).toString('hex')),
      },
      select: publicFields,
    });

    if (data.assignments?.length) {
      await tx.teacherAssignment.createMany({
        data: data.assignments.map((a) => ({
          schoolId,
          teacherUserId: created.id,
          classId: a.classId,
          subjectId: a.subjectId,
        })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  await sendInvitation(teacher.id, teacher.email, 'teacher');

  return getTeacherWithAssignments(schoolId, teacher.id);
}

/**
 * Modifie les informations et, si `assignments` est fourni, remplace
 * intégralement les affectations.
 *
 * Remplacement et non fusion : c'est ce qu'attend un écran d'édition qui
 * envoie la liste complète des classes cochées. Ne pas fournir le champ laisse
 * les affectations inchangées.
 */
export async function updateTeacher(
  schoolId: number,
  id: number,
  data: {
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    assignments?: AssignmentInput[];
  },
) {
  await getTeacher(schoolId, id);

  const email = data.email ? normalizeEmail(data.email) : undefined;
  if (email) {
    const clash = await prisma.user.findFirst({
      where: { schoolId, email, id: { not: id } },
    });
    if (clash) throw conflict('Cette adresse email est déjà utilisée par un autre compte de l’établissement.');
  }

  if (data.assignments) await assertAssignmentsBelongToSchool(schoolId, data.assignments);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        ...(email ? { email } : {}),
        ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
        ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
        ...(data.phone !== undefined
          ? { phone: data.phone ? normalizePhone(data.phone) : null }
          : {}),
      },
    });

    if (data.assignments) {
      await tx.teacherAssignment.deleteMany({ where: { teacherUserId: id } });
      if (data.assignments.length) {
        await tx.teacherAssignment.createMany({
          data: data.assignments.map((a) => ({
            schoolId,
            teacherUserId: id,
            classId: a.classId,
            subjectId: a.subjectId,
          })),
          skipDuplicates: true,
        });
      }
    }
  });

  return getTeacherWithAssignments(schoolId, id);
}

/**
 * Désactivation : le compte est archivé, **les notes déjà saisies sont
 * conservées** (c'est tout l'intérêt de l'archivage).
 *
 * Les sessions sont coupées dans la foulée : sans cela, un enseignant
 * désactivé garderait son accès jusqu'à l'expiration de son access token,
 * soit 30 jours.
 */
export async function archiveTeacher(schoolId: number, id: number) {
  await getTeacher(schoolId, id);

  const maintenant = new Date();

  // Archivage et coupure des sessions dans la même transaction : ce sont deux
  // écritures d'une seule décision. Séparées, une panne entre les deux
  // laisserait un compte archivé dont les refresh tokens survivent — et une
  // restauration ultérieure réactiverait des sessions jamais invalidées.
  const [teacher] = await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { archivedAt: maintenant, sessionsRevokedAt: maintenant },
      select: publicFields,
    }),
    prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: maintenant },
    }),
  ]);

  return teacher;
}

export async function restoreTeacher(schoolId: number, id: number) {
  await getTeacher(schoolId, id);
  return prisma.user.update({
    where: { id },
    data: { archivedAt: null },
    select: publicFields,
  });
}

/**
 * Suppression définitive, réservée à un compte déjà archivé, avec retapage
 * du nom exact — même garde-fou que pour une période ou une année scolaire
 * (voir `term.service.ts`). Refusée dès qu'une note ou une présence a été
 * saisie : les relations `Grade.teacherUserId` et `Attendance.recordedByUserId`
 * étant en `SET NULL`, supprimer le compte effacerait l'auteur sans que rien
 * ne le signale. Refusée aussi si l'enseignant est encore référent d'une
 * classe : `Class.homeroomTeacherId` est en `RESTRICT`, la base refuserait de
 * toute façon, mais avec un message SQL illisible pour une secrétaire.
 */
export async function deleteTeacherPermanently(
  schoolId: number,
  id: number,
  expectedName = '',
) {
  const teacher = await getTeacher(schoolId, id);

  if (!teacher.archivedAt) {
    throw conflict('Archivez le compte avant de le supprimer définitivement.', { teacherId: id });
  }

  const actual = `${teacher.firstName ?? ''} ${teacher.lastName ?? ''}`.trim().toLowerCase();
  if (expectedName.trim().toLowerCase() !== actual) {
    throw badRequest(
      "La confirmation ne correspond pas au nom de l'enseignant. Cette suppression est définitive.",
      { attendu: `${teacher.firstName ?? ''} ${teacher.lastName ?? ''}`.trim() },
    );
  }

  const gradeCount = await prisma.grade.count({ where: { teacherUserId: id } });
  if (gradeCount > 0) {
    throw conflict(
      `Suppression impossible : ${gradeCount} note(s) ont été saisies par cet enseignant. Archivez le compte plutôt.`,
      { gradeCount },
    );
  }

  const attendanceCount = await prisma.attendance.count({ where: { recordedByUserId: id } });
  if (attendanceCount > 0) {
    throw conflict(
      `Suppression impossible : ${attendanceCount} présence(s) ont été saisies par cet enseignant. Archivez le compte plutôt.`,
      { attendanceCount },
    );
  }

  const homeroomCount = await prisma.class.count({ where: { homeroomTeacherId: id } });
  if (homeroomCount > 0) {
    throw conflict(
      `Suppression impossible : cet enseignant est référent de ${homeroomCount} classe(s). Retirez-le de ces classes avant de supprimer son compte.`,
      { homeroomCount },
    );
  }

  await prisma.user.delete({ where: { id } });
}

async function getTeacherWithAssignments(schoolId: number, id: number) {
  const teacher = await prisma.user.findFirst({
    where: { id, schoolId, role: 'teacher' },
    select: {
      ...publicFields,
      assignments: {
        include: {
          class: { select: { id: true, name: true, level: true } },
          subject: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!teacher) throw notFound('Enseignant introuvable');

  const { assignments, ...rest } = teacher;
  return {
    ...rest,
    affectations: assignments.map((a) => ({
      id: a.id,
      classId: a.classId,
      className: a.class.name,
      level: a.class.level,
      subjectId: a.subjectId,
      subjectName: a.subject.name,
    })),
  };
}

/**
 * Vérifie que chaque classe et chaque matière visée appartient bien à l'école.
 * Sans ce contrôle, un admin pourrait affecter son enseignant à la classe d'un
 * autre établissement — et lui donner accès à ses notes.
 */
async function assertAssignmentsBelongToSchool(schoolId: number, assignments: AssignmentInput[]) {
  if (assignments.length === 0) return;

  const classIds = [...new Set(assignments.map((a) => a.classId))];
  const subjectIds = [...new Set(assignments.map((a) => a.subjectId))];

  const [classCount, subjectCount] = await Promise.all([
    prisma.class.count({ where: { id: { in: classIds }, schoolId } }),
    prisma.subject.count({ where: { id: { in: subjectIds }, schoolId } }),
  ]);

  if (classCount !== classIds.length) throw notFound('Classe introuvable dans cette école');
  if (subjectCount !== subjectIds.length) throw notFound('Matière introuvable dans cette école');
}
