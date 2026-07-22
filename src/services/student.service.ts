import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { sendInvitation } from './invitation.service';

/** Jamais `passwordHash` dans une réponse. */
const parentFields = {
  id: true,
  email: true,
  phone: true,
  firstName: true,
  lastName: true,
} as const;

export async function listStudents(
  schoolId: number,
  filters: { classId?: number; includeArchived?: boolean },
) {
  const students = await prisma.student.findMany({
    where: {
      schoolId,
      ...(filters.classId ? { classId: filters.classId } : {}),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    include: {
      class: { select: { id: true, name: true, level: true } },
      parents: { include: { parent: { select: parentFields } } },
    },
  });

  return students.map(({ parents, class: klass, ...student }) => ({
    ...student,
    classe: klass,
    parents: parents.map((p) => p.parent),
  }));
}

export async function getStudent(schoolId: number, id: number) {
  const student = await prisma.student.findFirst({
    where: { id, schoolId },
    include: {
      class: { select: { id: true, name: true, level: true } },
      parents: { include: { parent: { select: parentFields } } },
    },
  });
  if (!student) throw notFound('Élève introuvable');

  const { parents, class: klass, ...rest } = student;
  return { ...rest, classe: klass, parents: parents.map((p) => p.parent) };
}

export async function createStudent(
  schoolId: number,
  data: { firstName: string; lastName: string; classId: number; birthDate?: string },
) {
  await assertClassInSchool(schoolId, data.classId);

  const created = await prisma.student.create({
    data: {
      schoolId,
      classId: data.classId,
      firstName: data.firstName,
      lastName: data.lastName,
      birthDate: data.birthDate ? new Date(data.birthDate) : null,
    },
  });

  return getStudent(schoolId, created.id);
}

export async function updateStudent(
  schoolId: number,
  id: number,
  data: { firstName?: string; lastName?: string; classId?: number; birthDate?: string | null },
) {
  await getStudent(schoolId, id);
  if (data.classId !== undefined) await assertClassInSchool(schoolId, data.classId);

  await prisma.student.update({
    where: { id },
    data: {
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.classId !== undefined ? { classId: data.classId } : {}),
      ...(data.birthDate !== undefined
        ? { birthDate: data.birthDate ? new Date(data.birthDate) : null }
        : {}),
    },
  });

  return getStudent(schoolId, id);
}

/**
 * Archivage : l'élève sort des listes, des classements et des moyennes, mais
 * ses notes et son historique restent consultables.
 */
export async function archiveStudent(schoolId: number, id: number) {
  await getStudent(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function restoreStudent(schoolId: number, id: number) {
  await getStudent(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: null } });
  return getStudent(schoolId, id);
}

/**
 * Suppression définitive, en cascade sur les notes et les liens parents
 * (décision explicite du plan §1.4).
 *
 * `expectedName` est une confirmation obligatoire : l'opération efface la
 * scolarité complète d'un enfant et rien ne permet de revenir en arrière.
 * Exiger le nom exact évite le clic sur la mauvaise ligne d'un tableau.
 */
export async function deleteStudentPermanently(
  schoolId: number,
  id: number,
  expectedName: string,
) {
  const student = await getStudent(schoolId, id);

  const actual = `${student.firstName} ${student.lastName}`.trim().toLowerCase();
  if (expectedName.trim().toLowerCase() !== actual) {
    throw badRequest(
      "La confirmation ne correspond pas au nom de l'élève. Cette suppression est définitive.",
      { attendu: `${student.firstName} ${student.lastName}` },
    );
  }

  await prisma.student.delete({ where: { id } });
}

/**
 * Recherche d'un compte parent existant, par nom, email ou téléphone.
 *
 * Strictement limitée à l'école : sans ce filtre, l'association d'un parent
 * deviendrait un annuaire de tous les utilisateurs de la plateforme.
 */
export async function searchParents(schoolId: number, query: string) {
  const term = query.trim();
  if (term.length < 2) return [];

  return prisma.user.findMany({
    where: {
      schoolId,
      role: 'parent',
      archivedAt: null,
      OR: [
        { email: { contains: normalizeEmail(term), mode: 'insensitive' } },
        { phone: { contains: normalizePhone(term) } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ],
    },
    orderBy: [{ lastName: 'asc' }, { email: 'asc' }],
    take: 20,
    select: parentFields,
  });
}

/**
 * Associe un parent à un élève : soit un compte existant (`parentUserId`),
 * soit un nouveau compte créé par invitation.
 *
 * Aucun mot de passe ne transite par l'API : le compte est créé avec un secret
 * aléatoire inutilisable et le parent reçoit un lien pour définir le sien.
 */
export async function attachParent(
  schoolId: number,
  studentId: number,
  input:
    | { parentUserId: number }
    | { email: string; firstName?: string; lastName?: string; phone?: string },
) {
  await getStudent(schoolId, studentId);

  const parent =
    'parentUserId' in input
      ? await findExistingParent(schoolId, input.parentUserId)
      : await createParentAccount(schoolId, input);

  const already = await prisma.studentParent.findUnique({
    where: { studentId_parentUserId: { studentId, parentUserId: parent.id } },
  });
  if (already) throw conflict('Ce parent est déjà associé à cet élève');

  await prisma.studentParent.create({ data: { studentId, parentUserId: parent.id } });

  return getStudent(schoolId, studentId);
}

export async function detachParent(schoolId: number, studentId: number, parentUserId: number) {
  await getStudent(schoolId, studentId);

  const { count } = await prisma.studentParent.deleteMany({ where: { studentId, parentUserId } });
  if (count === 0) throw notFound("Ce parent n'est pas associé à cet élève");

  return getStudent(schoolId, studentId);
}

async function findExistingParent(schoolId: number, parentUserId: number) {
  const parent = await prisma.user.findFirst({
    where: { id: parentUserId, schoolId, role: 'parent', archivedAt: null },
    select: parentFields,
  });
  if (!parent) throw notFound('Parent introuvable dans cette école');
  return parent;
}

async function createParentAccount(
  schoolId: number,
  input: { email: string; firstName?: string; lastName?: string; phone?: string },
) {
  const email = normalizeEmail(input.email);
  const phone = input.phone ? normalizePhone(input.phone) : null;

  const existing = await prisma.user.findFirst({ where: { schoolId, email } });
  if (existing) {
    throw conflict(
      'Un compte utilise déjà cet email dans cette école. Associez le compte existant.',
      { parentUserId: existing.role === 'parent' ? existing.id : undefined },
    );
  }

  const parent = await prisma.user.create({
    data: {
      schoolId,
      email,
      phone,
      role: 'parent',
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      passwordHash: await argon2.hash(crypto.randomBytes(32).toString('hex')),
    },
    select: parentFields,
  });

  await sendInvitation(parent.id, parent.email, 'parent');

  return parent;
}

async function assertClassInSchool(schoolId: number, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId } });
  if (!klass) throw notFound('Classe introuvable dans cette école');
}
