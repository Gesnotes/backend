import crypto from 'node:crypto';
import argon2 from 'argon2';

import prisma from '../lib/prisma';
import type { Prisma } from '../generated/prisma/client';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { recordAudit } from './audit.service';
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

const RECENT_GRADES_LIMIT = 10;
const RECENT_ATTENDANCE_LIMIT = 10;

/**
 * Fiche complète d'un enseignant : identité (déjà couverte par `getTeacher`,
 * qui porte aussi le contrôle d'accès), affectations classe × matière,
 * dernières notes saisies et dernières présences enregistrées par ce compte —
 * le pendant de `getStudentDetail` (student.service.ts), mais pour un
 * enseignant plutôt qu'un élève.
 *
 * Une note ou une présence saisie par l'administration au nom d'un
 * enseignant n'a pas `teacherUserId`/`recordedByUserId` égal à son id : elle
 * n'apparaît donc pas ici, ce qui est le comportement voulu — cette fiche
 * retrace ce que CE compte a lui-même saisi.
 */
export async function getTeacherDetail(schoolId: number, id: number) {
  const teacher = await getTeacher(schoolId, id);

  const [assignments, recentGrades, recentAttendance, totalGrades] = await Promise.all([
    prisma.teacherAssignment.findMany({
      where: { teacherUserId: id, schoolId },
      orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
      select: {
        id: true,
        classId: true,
        class: { select: { name: true, level: true } },
        subjectId: true,
        subject: { select: { name: true } },
      },
    }),
    prisma.grade.findMany({
      where: { teacherUserId: id, schoolId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_GRADES_LIMIT,
      select: {
        id: true,
        value: true,
        maxValue: true,
        createdAt: true,
        student: { select: { id: true, firstName: true, lastName: true } },
        subject: { select: { id: true, name: true } },
        gradeType: { select: { label: true } },
      },
    }),
    prisma.attendance.findMany({
      where: { recordedByUserId: id, schoolId },
      orderBy: { date: 'desc' },
      take: RECENT_ATTENDANCE_LIMIT,
      select: {
        id: true,
        date: true,
        status: true,
        student: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.grade.count({ where: { teacherUserId: id, schoolId } }),
  ]);

  return {
    ...teacher,
    affectations: assignments.map((a) => ({
      id: a.id,
      classId: a.classId,
      className: a.class.name,
      level: a.class.level,
      subjectId: a.subjectId,
      subjectName: a.subject.name,
    })),
    totalNotesSaisies: totalGrades,
    dernieresNotes: recentGrades.map((grade) => ({
      id: grade.id,
      value: Number(grade.value),
      maxValue: Number(grade.maxValue),
      createdAt: grade.createdAt,
      eleve: grade.student,
      matiere: grade.subject,
      type: { label: grade.gradeType.label },
    })),
    dernieresPresences: recentAttendance.map((record) => ({
      id: record.id,
      date: record.date,
      status: record.status,
      eleve: record.student,
    })),
  };
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
      await reconcileAssignments(tx, schoolId, created.id, data.assignments);
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
 * Remplacement et non fusion côté résultat : c'est ce qu'attend un écran
 * d'édition qui envoie la liste complète des classes cochées. Ne pas fournir
 * le champ laisse les affectations inchangées. `reconcileAssignments` fait
 * ce remplacement en ne touchant que ce qui change (voir sa documentation) :
 * une affectation déjà présente garde son `id`, qu'un futur créneau
 * d'emploi du temps pourra référencer sans craindre qu'une simple
 * modification du téléphone de l'enseignant ne l'efface.
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
      await reconcileAssignments(tx, schoolId, id, data.assignments);
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
export async function archiveTeacher(schoolId: number, id: number, actingUserId: number) {
  const existing = await getTeacher(schoolId, id);

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

  await recordAudit({
    schoolId,
    actorUserId: actingUserId,
    action: 'account.archived',
    targetType: 'user',
    targetId: id,
    targetLabel: `${existing.firstName ?? ''} ${existing.lastName ?? ''}`.trim() || existing.email,
  });

  return teacher;
}

export async function restoreTeacher(schoolId: number, id: number, actingUserId: number) {
  const existing = await getTeacher(schoolId, id);
  const teacher = await prisma.user.update({
    where: { id },
    data: { archivedAt: null },
    select: publicFields,
  });

  await recordAudit({
    schoolId,
    actorUserId: actingUserId,
    action: 'account.restored',
    targetType: 'user',
    targetId: id,
    targetLabel: `${existing.firstName ?? ''} ${existing.lastName ?? ''}`.trim() || existing.email,
  });

  return teacher;
}

/**
 * Suppression définitive, réservée à un compte déjà archivé, avec retapage
 * du nom exact — même garde-fou que pour une période ou une année scolaire
 * (voir `term.service.ts`). Les notes et présences déjà saisies par cet
 * enseignant sont conservées : `Grade.teacherUserId` et
 * `Attendance.recordedByUserId` sont en `SET NULL`, seul l'auteur se
 * désolidarise. `Class.homeroomTeacherId` est en `RESTRICT` (`school_id`
 * n'est pas nullable, un `SET NULL` par défaut échouerait à l'exécution) :
 * on détache donc explicitement les classes dont il est référent avant de
 * supprimer le compte.
 */
export async function deleteTeacherPermanently(
  schoolId: number,
  id: number,
  expectedName: string,
  actingUserId: number,
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

  await prisma.$transaction(async (tx) => {
    await tx.class.updateMany({
      where: { homeroomTeacherId: id, schoolId },
      data: { homeroomTeacherId: null },
    });
    await tx.user.delete({ where: { id } });
  });

  await recordAudit({
    schoolId,
    actorUserId: actingUserId,
    action: 'account.permanently_deleted',
    targetType: 'user',
    targetId: id,
    targetLabel: `${teacher.firstName ?? ''} ${teacher.lastName ?? ''}`.trim() || teacher.email,
  });
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

/**
 * Fait converger les `TeacherAssignment` d'un enseignant vers `desired`, en
 * ne touchant que ce qui change — retire ce qui n'y est plus, ajoute ce qui
 * manque, laisse intactes (même `id`) les affectations déjà présentes.
 *
 * Un simple delete-all/create-all serait plus court, mais `TeacherModal`
 * renvoie la liste complète des affectations à chaque sauvegarde, même pour
 * ne changer que le téléphone : ça recréerait systématiquement toutes les
 * lignes avec de nouveaux `id`. Inoffensif tant que rien ne les référence,
 * mais un créneau d'emploi du temps (`TimetableSlot.teacherAssignmentId`)
 * s'ancre justement à cet `id` — le perdre à chaque édition de fiche
 * enseignant supprimerait en cascade tout son planning. On refuse aussi de
 * retirer une affectation qui a encore des créneaux actifs : la classe
 * doit d'abord être vidée de son emploi du temps depuis sa propre fiche.
 */
async function reconcileAssignments(
  tx: Prisma.TransactionClient,
  schoolId: number,
  teacherUserId: number,
  desired: AssignmentInput[],
): Promise<void> {
  const existing = await tx.teacherAssignment.findMany({ where: { teacherUserId, schoolId } });
  const key = (a: { classId: number; subjectId: number }) => `${a.classId}:${a.subjectId}`;
  const desiredKeys = new Set(desired.map(key));

  const toRemove = existing.filter((a) => !desiredKeys.has(key(a)));
  if (toRemove.length) {
    const withSlots = await tx.timetableSlot.count({
      where: { teacherAssignmentId: { in: toRemove.map((a) => a.id) }, archivedAt: null },
    });
    if (withSlots > 0) {
      throw conflict(
        "Impossible de retirer cette affectation : elle a des créneaux dans l'emploi du temps. Supprimez-les d'abord depuis la fiche de la classe.",
      );
    }
    await tx.teacherAssignment.deleteMany({ where: { id: { in: toRemove.map((a) => a.id) } } });
  }

  const existingKeys = new Set(existing.map(key));
  const toCreate = desired.filter((a) => !existingKeys.has(key(a)));
  if (toCreate.length) {
    await tx.teacherAssignment.createMany({
      data: toCreate.map((a) => ({ schoolId, teacherUserId, classId: a.classId, subjectId: a.subjectId })),
      skipDuplicates: true,
    });
  }
}
