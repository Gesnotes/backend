import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import type { SignupRequestStatus } from '../generated/prisma/enums';
import { badRequest, conflict, notFound } from '../errors/AppError';
import { normalizeEmail } from '../lib/normalize';
import { sendInvitation } from './invitation.service';

/**
 * Supervision de la plateforme par l'équipe Gesnotes : traiter les demandes
 * d'inscription (les transformer en écoles réelles, ou les écarter) et
 * observer l'activité globale — combien d'écoles, combien d'élèves, combien
 * d'enseignants y sont réellement entrés.
 */

export async function listSignupRequests(status?: SignupRequestStatus) {
  return prisma.signupRequest.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
  });
}

export interface AcceptSignupRequestInput {
  schoolName?: string;
  city?: string;
}

/**
 * Accepte une demande : crée l'école et son premier compte administrateur,
 * puis lui envoie l'invitation habituelle (aucun mot de passe transmis, le
 * lien en définit un). La demande est marquée traitée et gardée en lien avec
 * l'école créée, pour qu'on retrouve d'où elle vient.
 */
export async function acceptSignupRequest(id: number, input: AcceptSignupRequestInput = {}) {
  const request = await prisma.signupRequest.findUnique({ where: { id } });
  if (!request) throw notFound('Demande introuvable');
  if (request.status === 'traite') {
    throw conflict('Cette demande a déjà été traitée.', { signupRequestId: id });
  }

  const name = (input.schoolName ?? request.schoolName).trim();
  const city = (input.city ?? request.city).trim();

  const [firstName, ...rest] = request.contactName.trim().split(/\s+/);
  const lastName = rest.join(' ');

  const { school, admin } = await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({ data: { name, city } });

    // Sans ces catégories, aucune évaluation n'est saisissable : `POST
    // /evaluations` exige un `gradeTypeId` existant pour l'école, et rien ne
    // permet d'en créer par l'API (référentiel volontairement fermé). Mêmes
    // valeurs par défaut que le seed de démonstration (prisma/seed.ts).
    await tx.gradeType.createMany({
      data: [
        { schoolId: school.id, code: 'interrogation', label: 'Interrogation', weight: 1, position: 1 },
        { schoolId: school.id, code: 'devoir', label: 'Devoir', weight: 2, position: 2 },
        { schoolId: school.id, code: 'composition', label: 'Composition', weight: 3, position: 3 },
      ],
    });

    const admin = await tx.user.create({
      data: {
        schoolId: school.id,
        email: normalizeEmail(request.email),
        role: 'admin',
        firstName: firstName || null,
        lastName: lastName || null,
        // Secret aléatoire : le compte n'est utilisable qu'après invitation.
        passwordHash: await argon2.hash(crypto.randomBytes(32).toString('hex')),
      },
    });

    await tx.signupRequest.update({
      where: { id },
      data: { status: 'traite', schoolId: school.id },
    });

    return { school, admin };
  });

  await sendInvitation(admin.id, admin.email, 'admin');

  return { school, adminEmail: admin.email };
}

/** Écarte une demande sans créer d'école (doublon, injoignable, hors cible…). */
export async function declineSignupRequest(id: number): Promise<void> {
  const request = await prisma.signupRequest.findUnique({ where: { id } });
  if (!request) throw notFound('Demande introuvable');
  if (request.status === 'traite') {
    throw conflict('Cette demande a déjà été traitée.', { signupRequestId: id });
  }

  await prisma.signupRequest.update({ where: { id }, data: { status: 'traite' } });
}

export interface PlatformOverview {
  schools: number;
  students: number;
  classes: number;
  pendingSignupRequests: number;
  users: { admin: number; teacher: number; parent: number; total: number };
}

/** Totaux plateforme, tous établissements confondus — comptes archivés exclus. */
export async function getOverview(): Promise<PlatformOverview> {
  const [schools, students, classes, pendingSignupRequests, usersByRole] = await Promise.all([
    prisma.school.count(),
    prisma.student.count({ where: { archivedAt: null } }),
    prisma.class.count({ where: { archivedAt: null } }),
    prisma.signupRequest.count({ where: { status: 'nouveau' } }),
    prisma.user.groupBy({ by: ['role'], where: { archivedAt: null }, _count: { _all: true } }),
  ]);

  const users = { admin: 0, teacher: 0, parent: 0 };
  for (const row of usersByRole) users[row.role] = row._count._all;

  return {
    schools,
    students,
    classes,
    pendingSignupRequests,
    users: { ...users, total: users.admin + users.teacher + users.parent },
  };
}

export interface SchoolWithMetrics {
  id: number;
  name: string;
  city: string | null;
  createdAt: Date | null;
  archivedAt: Date | null;
  students: number;
  classes: number;
  admins: number;
  teachers: number;
  parents: number;
}

/** Une ligne par école, avec ses effectifs — comptes et élèves archivés exclus. */
export async function listSchoolsWithMetrics(): Promise<SchoolWithMetrics[]> {
  const [schools, usersByRole] = await Promise.all([
    prisma.school.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            students: { where: { archivedAt: null } },
            classes: { where: { archivedAt: null } },
          },
        },
      },
    }),
    prisma.user.groupBy({
      by: ['schoolId', 'role'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
  ]);

  const roleCounts = new Map<number, { admin: number; teacher: number; parent: number }>();
  for (const row of usersByRole) {
    const entry = roleCounts.get(row.schoolId) ?? { admin: 0, teacher: 0, parent: 0 };
    entry[row.role] = row._count._all;
    roleCounts.set(row.schoolId, entry);
  }

  return schools.map((school) => {
    const roles = roleCounts.get(school.id) ?? { admin: 0, teacher: 0, parent: 0 };
    return {
      id: school.id,
      name: school.name,
      city: school.city,
      createdAt: school.createdAt,
      archivedAt: school.archivedAt,
      students: school._count.students,
      classes: school._count.classes,
      admins: roles.admin,
      teachers: roles.teacher,
      parents: roles.parent,
    };
  });
}

async function getSchoolOrThrow(id: number) {
  const school = await prisma.school.findUnique({ where: { id } });
  if (!school) throw notFound('École introuvable');
  return school;
}

/**
 * Suspend une école (impayé, litige, fermeture provisoire...) : ses comptes
 * ne peuvent plus se connecter (`schoolContext` et `identify()` l'excluent),
 * mais rien n'est détruit — restaurable à tout moment.
 *
 * Coupe aussi les sessions déjà ouvertes : sans cela, un access token émis
 * avant la suspension resterait valable jusqu'à son expiration (30 jours par
 * défaut), comme pour l'archivage d'un compte (voir `revokeAllSessions`).
 */
export async function suspendSchool(id: number): Promise<void> {
  const school = await getSchoolOrThrow(id);
  if (school.archivedAt) throw conflict('Cette école est déjà suspendue.', { schoolId: id });

  const now = new Date();
  await prisma.$transaction([
    prisma.school.update({ where: { id }, data: { archivedAt: now } }),
    prisma.refreshToken.updateMany({
      where: { user: { schoolId: id }, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.user.updateMany({ where: { schoolId: id }, data: { sessionsRevokedAt: now } }),
  ]);
}

export async function restoreSchool(id: number): Promise<void> {
  const school = await getSchoolOrThrow(id);
  if (!school.archivedAt) throw conflict("Cette école n'est pas suspendue.", { schoolId: id });

  await prisma.school.update({ where: { id }, data: { archivedAt: null } });
}

/**
 * Suppression définitive d'une école et de tout ce qu'elle contient.
 *
 * Réservée aux écoles déjà suspendues, avec retapage du nom exact — même
 * garde-fou que pour une période ou une année scolaire (voir
 * `term.service.ts`). Contrairement à `resetDatabase()` (tests), tout est
 * borné à `schoolId` : l'ordre des suppressions suit la même chaîne de
 * dépendances FK, mais une seule école y passe.
 */
export async function deleteSchoolPermanently(id: number, expectedName: string): Promise<void> {
  const school = await getSchoolOrThrow(id);

  if (!school.archivedAt) {
    throw conflict('Suspendez cette école avant de la supprimer définitivement.', { schoolId: id });
  }

  if (expectedName.trim().toLowerCase() !== school.name.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au nom de l’école. Cette suppression est définitive.',
      { attendu: school.name },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.grade.deleteMany({ where: { schoolId: id } });
    await tx.attendance.deleteMany({ where: { schoolId: id } });
    await tx.enrollmentDecision.deleteMany({ where: { schoolId: id } });
    await tx.evaluation.deleteMany({ where: { schoolId: id } });
    await tx.subjectCoefficient.deleteMany({ where: { subject: { schoolId: id } } });
    await tx.teacherAssignment.deleteMany({ where: { schoolId: id } });
    await tx.studentParent.deleteMany({ where: { student: { schoolId: id } } });
    await tx.student.deleteMany({ where: { schoolId: id } });
    await tx.gradeType.deleteMany({ where: { schoolId: id } });
    await tx.subject.deleteMany({ where: { schoolId: id } });
    await tx.class.deleteMany({ where: { schoolId: id } });
    await tx.term.deleteMany({ where: { schoolId: id } });
    await tx.schoolYear.deleteMany({ where: { schoolId: id } });
    await tx.device.deleteMany({ where: { user: { schoolId: id } } });
    await tx.refreshToken.deleteMany({ where: { user: { schoolId: id } } });
    await tx.passwordResetToken.deleteMany({ where: { user: { schoolId: id } } });
    await tx.user.deleteMany({ where: { schoolId: id } });
    await tx.school.delete({ where: { id } });
  });
}
