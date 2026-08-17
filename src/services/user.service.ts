import prisma from '../lib/prisma';
import type { Role } from '../generated/prisma/enums';
import { badRequest, notFound } from '../errors/AppError';
import { recordAudit } from './audit.service';
import { revokeAllSessions } from './auth.service';
import { accountFields } from './userFields';

function accountLabel(user: { firstName: string | null; lastName: string | null; email: string }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
}

/**
 * Vue unifiée des comptes de l'école (admin + enseignant + parent), pour
 * l'écran « Utilisateurs » — l'annuaire par rôle (enseignants, élèves...)
 * existe déjà ailleurs, celui-ci sert à voir/gérer les comptes eux-mêmes,
 * tous rôles confondus.
 *
 * L'archivage/restauration ici ne couvre PAS les enseignants : leur cycle de
 * vie a des effets de bord propres (détachement de `Class.homeroomTeacherId`,
 * suppression définitive avec retapage du nom) déjà gérés par
 * `teacher.service.ts` — dupliquer cette logique ici créerait deux chemins
 * pour la même action. Les comptes enseignant restent visibles dans la
 * liste pour la vue d'ensemble, mais leur action renvoie vers l'écran
 * Enseignants.
 */

export interface UserAccountView {
  id: number;
  role: Role;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  archivedAt: string | null;
  createdAt: string | null;
}

function toView(user: {
  id: number;
  role: Role;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  archivedAt: Date | null;
  createdAt: Date | null;
}): UserAccountView {
  return {
    id: user.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phone: user.phone,
    archivedAt: user.archivedAt ? user.archivedAt.toISOString() : null,
    createdAt: user.createdAt ? user.createdAt.toISOString() : null,
  };
}

export async function listUsers(
  schoolId: number,
  filters: { role?: Role; includeArchived?: boolean } = {},
): Promise<UserAccountView[]> {
  const users = await prisma.user.findMany({
    where: {
      schoolId,
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ role: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
    select: { ...accountFields, role: true },
  });
  return users.map(toView);
}

async function getManageableUser(schoolId: number, id: number) {
  const user = await prisma.user.findFirst({ where: { id, schoolId } });
  if (!user) throw notFound('Compte introuvable');
  if (user.role === 'teacher') {
    throw badRequest("Gérez ce compte depuis l'écran Enseignants : son archivage a des effets propres (classe référente...).");
  }
  return user;
}

export async function archiveUserAccount(
  schoolId: number,
  id: number,
  actingUserId: number,
): Promise<UserAccountView> {
  if (id === actingUserId) {
    throw badRequest('Vous ne pouvez pas archiver votre propre compte.');
  }
  const existing = await getManageableUser(schoolId, id);

  await revokeAllSessions(id);
  const updated = await prisma.user.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: { ...accountFields, role: true },
  });

  await recordAudit({
    schoolId,
    actorUserId: actingUserId,
    action: 'account.archived',
    targetType: 'user',
    targetId: id,
    targetLabel: accountLabel(existing),
  });

  return toView(updated);
}

export async function restoreUserAccount(
  schoolId: number,
  id: number,
  actingUserId: number,
): Promise<UserAccountView> {
  const existing = await getManageableUser(schoolId, id);
  const updated = await prisma.user.update({
    where: { id },
    data: { archivedAt: null },
    select: { ...accountFields, role: true },
  });

  await recordAudit({
    schoolId,
    actorUserId: actingUserId,
    action: 'account.restored',
    targetType: 'user',
    targetId: id,
    targetLabel: accountLabel(existing),
  });

  return toView(updated);
}
