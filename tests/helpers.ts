import argon2 from 'argon2';

import prisma from '../src/lib/prisma';
import { normalizeEmail, normalizePhone } from '../src/lib/normalize';
import type { Role } from '../src/generated/prisma/enums';

export const TEST_PASSWORD = 'motdepasse123';

/** Supprime toutes les données de test, dans l'ordre des dépendances. */
export async function resetDatabase() {
  await prisma.grade.deleteMany();
  await prisma.subjectCoefficient.deleteMany();
  await prisma.teacherAssignment.deleteMany();
  await prisma.studentParent.deleteMany();
  await prisma.student.deleteMany();
  await prisma.gradeType.deleteMany();
  await prisma.subject.deleteMany();
  await prisma.class.deleteMany();
  await prisma.term.deleteMany();
  await prisma.device.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.school.deleteMany();
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
