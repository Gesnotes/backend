import argon2 from 'argon2';
import crypto from 'node:crypto';

import prisma from '../lib/prisma';
import type { SignupRequestStatus } from '../generated/prisma/enums';
import { conflict, notFound } from '../errors/AppError';
import { normalizeEmail, slugify } from '../lib/normalize';
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
  /** Par défaut, dérivé du nom de l'école. Ajusté si déjà pris. */
  subdomain?: string;
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
  const subdomain = await resolveUniqueSubdomain(input.subdomain?.trim() || slugify(name));

  const [firstName, ...rest] = request.contactName.trim().split(/\s+/);
  const lastName = rest.join(' ');

  const { school, admin } = await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({ data: { name, city, subdomain } });

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

/** Essaie le sous-domaine proposé, puis lui ajoute un suffixe numérique tant qu'il est pris. */
async function resolveUniqueSubdomain(base: string): Promise<string> {
  const cleaned = base || 'ecole';
  let candidate = cleaned;
  let suffix = 2;

  while (await prisma.school.findUnique({ where: { subdomain: candidate } })) {
    candidate = `${cleaned}-${suffix}`.slice(0, 63);
    suffix += 1;
  }

  return candidate;
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
  subdomain: string;
  city: string | null;
  createdAt: Date | null;
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
      subdomain: school.subdomain,
      city: school.city,
      createdAt: school.createdAt,
      students: school._count.students,
      classes: school._count.classes,
      admins: roles.admin,
      teachers: roles.teacher,
      parents: roles.parent,
    };
  });
}
