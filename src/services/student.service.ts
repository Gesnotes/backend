import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import type { AuthPayload } from '../types/express';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { contactFields, identityFields } from './userFields';
import { normalizeEmail, normalizePhone } from '../lib/normalize';
import { sendInvitation } from './invitation.service';

export const STUDENTS_PAGE_SIZE = 100;

/**
 * Restreint la lecture au périmètre de l'appelant.
 *
 * Un enseignant ne consulte que les élèves des classes où il enseigne : le
 * reste du code le borne partout ailleurs à ses affectations, il n'y a aucune
 * raison que l'annuaire des élèves fasse exception.
 */
async function scopeFor(auth: AuthPayload, classId?: number) {
  if (auth.role === 'admin') {
    return classId ? { classId } : {};
  }

  const assignments = await prisma.teacherAssignment.findMany({
    where: { teacherUserId: auth.userId },
    select: { classId: true },
  });
  const classIds = [...new Set(assignments.map((a) => a.classId))];

  // Une classe demandée hors périmètre ne renvoie rien plutôt qu'une erreur :
  // l'enseignant n'a pas à découvrir quelles classes existent.
  if (classId !== undefined) {
    return { classId: classIds.includes(classId) ? classId : -1 };
  }
  return { classId: { in: classIds } };
}

/**
 * Les coordonnées des familles sont réservées à l'administration. Un
 * enseignant voit le nom des parents, pas leur email ni leur téléphone.
 */
const parentSelectFor = (auth: AuthPayload) =>
  auth.role === 'admin' ? contactFields : identityFields;

export async function listStudents(
  auth: AuthPayload,
  filters: { classId?: number; includeArchived?: boolean; page?: number },
) {
  const page = Math.max(1, filters.page ?? 1);

  const where = {
    schoolId: auth.schoolId,
    ...(await scopeFor(auth, filters.classId)),
    ...(filters.includeArchived ? {} : { archivedAt: null }),
  };

  const [total, students] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      // Sans pagination, un établissement de 900 élèves construit plusieurs
      // mégaoctets de JSON à chaque ouverture de l'écran.
      skip: (page - 1) * STUDENTS_PAGE_SIZE,
      take: STUDENTS_PAGE_SIZE,
      include: {
        class: { select: { id: true, name: true, level: true } },
        parents: { include: { parent: { select: parentSelectFor(auth) } } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize: STUDENTS_PAGE_SIZE,
    students: students.map(({ parents, class: klass, ...student }) => ({
      ...student,
      classe: klass,
      parents: parents.map((p) => p.parent),
    })),
  };
}

export async function getStudent(auth: AuthPayload, id: number) {
  return loadStudent(auth.schoolId, id, parentSelectFor(auth), await scopeFor(auth));
}

/**
 * Lecture non restreinte, pour les opérations d'écriture réservées à
 * l'administration : la route porte déjà `requireRole('admin')`.
 */
function getStudentForAdmin(schoolId: number, id: number) {
  return loadStudent(schoolId, id, contactFields, {});
}

async function loadStudent(
  schoolId: number,
  id: number,
  parentSelect: typeof contactFields | typeof identityFields,
  scope: Record<string, unknown>,
) {
  const student = await prisma.student.findFirst({
    where: { id, schoolId, ...scope },
    include: {
      class: { select: { id: true, name: true, level: true } },
      parents: { include: { parent: { select: parentSelect } } },
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

  return getStudentForAdmin(schoolId, created.id);
}

export async function updateStudent(
  schoolId: number,
  id: number,
  data: { firstName?: string; lastName?: string; classId?: number; birthDate?: string | null },
) {
  await getStudentForAdmin(schoolId, id);
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

  return getStudentForAdmin(schoolId, id);
}

/**
 * Archivage : l'élève sort des listes, des classements et des moyennes, mais
 * ses notes et son historique restent consultables.
 */
export async function archiveStudent(schoolId: number, id: number) {
  await getStudentForAdmin(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function restoreStudent(schoolId: number, id: number) {
  await getStudentForAdmin(schoolId, id);
  await prisma.student.update({ where: { id }, data: { archivedAt: null } });
  return getStudentForAdmin(schoolId, id);
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
  const student = await getStudentForAdmin(schoolId, id);

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
    select: contactFields,
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
  await getStudentForAdmin(schoolId, studentId);

  const parent =
    'parentUserId' in input
      ? await findExistingParent(schoolId, input.parentUserId)
      : await createParentAccount(schoolId, input);

  const already = await prisma.studentParent.findUnique({
    where: { studentId_parentUserId: { studentId, parentUserId: parent.id } },
  });
  if (already) throw conflict('Ce parent est déjà associé à cet élève');

  await prisma.studentParent.create({ data: { studentId, parentUserId: parent.id } });

  return getStudentForAdmin(schoolId, studentId);
}

export async function detachParent(schoolId: number, studentId: number, parentUserId: number) {
  await getStudentForAdmin(schoolId, studentId);

  const { count } = await prisma.studentParent.deleteMany({ where: { studentId, parentUserId } });
  if (count === 0) throw notFound("Ce parent n'est pas associé à cet élève");

  return getStudentForAdmin(schoolId, studentId);
}

async function findExistingParent(schoolId: number, parentUserId: number) {
  const parent = await prisma.user.findFirst({
    where: { id: parentUserId, schoolId, role: 'parent', archivedAt: null },
    select: contactFields,
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
    // Cas courant : un enseignant dont l'enfant est scolarisé sur place.
    // Conseiller « associez le compte existant » sans donner son identifiant
    // laisserait l'administration bloquée sur une action irréalisable.
    if (existing.role !== 'parent') {
      throw conflict(
        `Cet email est déjà utilisé par un compte ${existing.role} de l'établissement. Utilisez une autre adresse pour le compte parent.`,
        { compteExistant: { id: existing.id, role: existing.role } },
      );
    }

    throw conflict(
      'Un compte parent utilise déjà cet email dans cette école. Associez-le plutôt que d\'en créer un second.',
      { compteExistant: { id: existing.id, role: existing.role }, parentUserId: existing.id },
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
    select: contactFields,
  });

  await sendInvitation(parent.id, parent.email, 'parent');

  return parent;
}

async function assertClassInSchool(schoolId: number, classId: number) {
  const klass = await prisma.class.findFirst({ where: { id: classId, schoolId } });
  if (!klass) throw notFound('Classe introuvable dans cette école');
}
