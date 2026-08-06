import argon2 from 'argon2';

import prisma from '../src/lib/prisma';
import { Prisma } from '../src/generated/prisma/client';
import { normalizeEmail, normalizePhone } from '../src/lib/normalize';
import type { Role } from '../src/generated/prisma/enums';

export const TEST_PASSWORD = 'motdepasse123';

/** Supprime toutes les données de test, dans l'ordre des dépendances. */
export async function resetDatabase() {
  await prisma.staffRefreshToken.deleteMany();
  await prisma.staffUser.deleteMany();
  await prisma.signupRequest.deleteMany();
  await prisma.grade.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.enrollmentDecision.deleteMany();
  await prisma.evaluation.deleteMany();
  await prisma.subjectCoefficient.deleteMany();
  await prisma.teacherAssignment.deleteMany();
  await prisma.studentParent.deleteMany();
  await prisma.student.deleteMany();
  await prisma.gradeType.deleteMany();
  await prisma.subject.deleteMany();
  await prisma.class.deleteMany();
  await prisma.term.deleteMany();
  await prisma.schoolYear.deleteMany();
  await prisma.device.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.school.deleteMany();
}

/** Crée une évaluation de test avec des valeurs par défaut raisonnables. */
export function seedEvaluation(data: {
  schoolId: number;
  classId: number;
  subjectId: number;
  gradeTypeId: number;
  termId: number;
  teacherUserId?: number;
  label?: string;
  maxValue?: number;
  date?: Date | null;
}) {
  return prisma.evaluation.create({
    data: {
      schoolId: data.schoolId,
      classId: data.classId,
      subjectId: data.subjectId,
      gradeTypeId: data.gradeTypeId,
      termId: data.termId,
      teacherUserId: data.teacherUserId ?? null,
      label: data.label ?? 'Éval test',
      maxValue: data.maxValue ?? 20,
      date: data.date ?? null,
    },
  });
}

/**
 * Crée une note de test en lui rattachant une évaluation.
 *
 * Reprend la forme d'avant les évaluations : passer `evaluationId` pour
 * regrouper plusieurs notes sur la même évaluation, sinon une évaluation
 * dédiée est créée (la classe est déduite de l'élève).
 */
export async function seedGrade(data: {
  schoolId: number;
  studentId: number;
  subjectId: number;
  gradeTypeId: number;
  termId: number;
  value: number | Prisma.Decimal;
  maxValue?: number;
  comment?: string | null;
  teacherUserId?: number;
  evaluationId?: number;
  label?: string;
}) {
  const maxValue = data.maxValue ?? 20;

  let evaluationId = data.evaluationId;
  if (evaluationId === undefined) {
    const student = await prisma.student.findUniqueOrThrow({
      where: { id: data.studentId },
      select: { classId: true },
    });
    const evaluation = await seedEvaluation({
      schoolId: data.schoolId,
      classId: student.classId,
      subjectId: data.subjectId,
      gradeTypeId: data.gradeTypeId,
      termId: data.termId,
      teacherUserId: data.teacherUserId,
      label: data.label,
      maxValue,
    });
    evaluationId = evaluation.id;
  }

  return prisma.grade.create({
    data: {
      schoolId: data.schoolId,
      studentId: data.studentId,
      evaluationId,
      subjectId: data.subjectId,
      gradeTypeId: data.gradeTypeId,
      termId: data.termId,
      teacherUserId: data.teacherUserId ?? null,
      value: data.value,
      maxValue,
      comment: data.comment ?? null,
    },
  });
}

/** Crée un enregistrement de présence de test. */
export function seedAttendance(data: {
  schoolId: number;
  studentId: number;
  classId: number;
  date: Date | string;
  status: 'present' | 'absent' | 'late';
  comment?: string | null;
  recordedByUserId?: number;
}) {
  return prisma.attendance.create({
    data: {
      schoolId: data.schoolId,
      studentId: data.studentId,
      classId: data.classId,
      date: typeof data.date === 'string' ? new Date(data.date) : data.date,
      status: data.status,
      comment: data.comment ?? null,
      recordedByUserId: data.recordedByUserId ?? null,
    },
  });
}

export function createSchool(subdomain: string, name = `École ${subdomain}`) {
  return prisma.school.create({ data: { name, subdomain } });
}

export async function createUser(options: {
  schoolId: number;
  email: string;
  role: Role;
  phone?: string;
  password?: string;
  archived?: boolean;
}) {
  return prisma.user.create({
    data: {
      schoolId: options.schoolId,
      email: normalizeEmail(options.email),
      phone: options.phone ? normalizePhone(options.phone) : null,
      role: options.role,
      passwordHash: await argon2.hash(options.password ?? TEST_PASSWORD),
      archivedAt: options.archived ? new Date() : null,
    },
  });
}

/** Compte de l'équipe Gesnotes, hors périmètre multi-écoles. */
export async function createStaffUser(options: {
  email: string;
  password?: string;
  archived?: boolean;
}) {
  return prisma.staffUser.create({
    data: {
      email: normalizeEmail(options.email),
      passwordHash: await argon2.hash(options.password ?? TEST_PASSWORD),
      archivedAt: options.archived ? new Date() : null,
    },
  });
}
