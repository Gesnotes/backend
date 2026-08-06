import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';

/**
 * Années scolaires (« 2025-2026 »).
 *
 * Regroupe les périodes (trimestres, semestres) d'une même rentrée. Le
 * rattachement d'une période à une année est optionnel : une école qui n'a
 * pas encore créé d'année continue de fonctionner exactement comme avant,
 * `GET /terms` n'en a jamais eu besoin.
 */

export interface SchoolYearView {
  id: number;
  label: string;
  startDate: string | null;
  endDate: string | null;
  /** Année en cours à la date du jour. Au plus une l'est. */
  isCurrent: boolean;
  /** Non nul : l'année est sortie des sélecteurs, sans rien perdre. */
  archivedAt: string | null;
  /** Nombre de périodes rattachées — ce qu'une suppression définitive détacherait. */
  termCount: number;
  /** Nombre de classes rattachées — pareillement détachées, pas détruites. */
  classCount: number;
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Même règle que pour une période : les bornes sont comparées en jours, pas en instants. */
function isCurrentSchoolYear(
  year: { startDate: Date | null; endDate: Date | null },
  today: string,
): boolean {
  if (!year.startDate || !year.endDate) return false;
  return toIsoDay(year.startDate) <= today && today <= toIsoDay(year.endDate);
}

type SchoolYearRow = {
  id: number;
  label: string;
  startDate: Date | null;
  endDate: Date | null;
  archivedAt: Date | null;
  _count: { terms: number; classes: number };
};

const schoolYearSelect = {
  id: true,
  label: true,
  startDate: true,
  endDate: true,
  archivedAt: true,
  _count: { select: { terms: true, classes: true } },
} as const;

function toView(year: SchoolYearRow, today: string): SchoolYearView {
  return {
    id: year.id,
    label: year.label,
    startDate: year.startDate ? toIsoDay(year.startDate) : null,
    endDate: year.endDate ? toIsoDay(year.endDate) : null,
    isCurrent: year.archivedAt === null && isCurrentSchoolYear(year, today),
    archivedAt: year.archivedAt ? year.archivedAt.toISOString() : null,
    termCount: year._count.terms,
    classCount: year._count.classes,
  };
}

/**
 * Années de l'école, de la plus ancienne à la plus récente.
 *
 * Les archivées sont exclues par défaut, comme pour les périodes : seul
 * l'écran des archives demande `includeArchived`.
 */
export async function listSchoolYears(
  schoolId: number,
  includeArchived = false,
): Promise<SchoolYearView[]> {
  const years = await prisma.schoolYear.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: schoolYearSelect,
  });

  const today = toIsoDay(new Date());
  return years.map((year) => toView(year, today));
}

export async function getSchoolYear(schoolId: number, id: number): Promise<SchoolYearView> {
  const year = await prisma.schoolYear.findFirst({ where: { id, schoolId }, select: schoolYearSelect });
  if (!year) throw notFound('Année scolaire introuvable');

  return toView(year, toIsoDay(new Date()));
}

export interface SchoolYearInput {
  label: string;
  startDate?: string | null;
  endDate?: string | null;
}

function assertDateRange(startDate?: string | null, endDate?: string | null) {
  if ((startDate == null) !== (endDate == null)) {
    throw badRequest('Indiquez la date de début et la date de fin, ou laissez les deux vides.');
  }
  if (startDate != null && endDate != null && startDate > endDate) {
    throw badRequest('La date de fin doit venir après la date de début.');
  }
}

/** Deux années qui se chevauchent rendent `isCurrent` ambigu. */
async function assertNoOverlap(
  schoolId: number,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  excludeId?: number,
) {
  if (startDate == null || endDate == null) return;

  const overlapping = await prisma.schoolYear.findFirst({
    where: {
      schoolId,
      archivedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startDate: { lte: new Date(endDate) },
      endDate: { gte: new Date(startDate) },
    },
    select: { id: true, label: true },
  });

  if (overlapping) {
    throw conflict(`Ces dates se chevauchent avec l'année « ${overlapping.label} ».`, {
      schoolYearId: overlapping.id,
    });
  }
}

export async function createSchoolYear(
  schoolId: number,
  data: SchoolYearInput,
): Promise<SchoolYearView> {
  assertDateRange(data.startDate, data.endDate);
  await assertNoOverlap(schoolId, data.startDate, data.endDate);

  const year = await prisma.schoolYear.create({
    data: {
      schoolId,
      label: data.label,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    },
    select: schoolYearSelect,
  });

  return toView(year, toIsoDay(new Date()));
}

export async function updateSchoolYear(
  schoolId: number,
  id: number,
  data: Partial<SchoolYearInput>,
): Promise<SchoolYearView> {
  const existing = await prisma.schoolYear.findFirst({
    where: { id, schoolId },
    select: { id: true, startDate: true, endDate: true },
  });
  if (!existing) throw notFound('Année scolaire introuvable');

  const startDate =
    data.startDate !== undefined ? data.startDate : existing.startDate && toIsoDay(existing.startDate);
  const endDate =
    data.endDate !== undefined ? data.endDate : existing.endDate && toIsoDay(existing.endDate);

  assertDateRange(startDate, endDate);
  await assertNoOverlap(schoolId, startDate, endDate, id);

  const year = await prisma.schoolYear.update({
    where: { id },
    data: {
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.startDate !== undefined
        ? { startDate: data.startDate ? new Date(data.startDate) : null }
        : {}),
      ...(data.endDate !== undefined ? { endDate: data.endDate ? new Date(data.endDate) : null } : {}),
    },
    select: schoolYearSelect,
  });

  return toView(year, toIsoDay(new Date()));
}

/**
 * Archivage : comportement par défaut de la suppression, comme pour une
 * période. N'archive pas les périodes rattachées — un directeur peut vouloir
 * garder une période visible indépendamment de l'année qui la regroupe.
 */
export async function archiveSchoolYear(schoolId: number, id: number): Promise<SchoolYearView> {
  await getSchoolYear(schoolId, id);

  const year = await prisma.schoolYear.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: schoolYearSelect,
  });

  return toView(year, toIsoDay(new Date()));
}

export async function restoreSchoolYear(schoolId: number, id: number): Promise<SchoolYearView> {
  const existing = await getSchoolYear(schoolId, id);
  await assertNoOverlap(schoolId, existing.startDate, existing.endDate, id);

  const year = await prisma.schoolYear.update({
    where: { id },
    data: { archivedAt: null },
    select: schoolYearSelect,
  });

  return toView(year, toIsoDay(new Date()));
}

/**
 * Suppression définitive. Réservée aux années déjà archivées, libellé exact
 * à retaper — même garde-fou que pour une période.
 *
 * Les périodes et les classes rattachées ne sont pas détruites :
 * `terms.school_year_id` et `classes.school_year_id` sont en RESTRICT en
 * base, donc elles sont détachées (repassées à `null`) avant la suppression
 * de l'année. Chacune garde son historique intact, elle perd seulement son
 * regroupement par année.
 */
export async function deleteSchoolYearPermanently(
  schoolId: number,
  id: number,
  expectedLabel: string,
): Promise<void> {
  const year = await getSchoolYear(schoolId, id);

  if (!year.archivedAt) {
    throw conflict('Archivez l’année avant de la supprimer définitivement.', { schoolYearId: id });
  }

  if (expectedLabel.trim().toLowerCase() !== year.label.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au libellé de l’année. Cette suppression est définitive.',
      { attendu: year.label },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.term.updateMany({ where: { schoolYearId: id }, data: { schoolYearId: null } });
    await tx.class.updateMany({ where: { schoolYearId: id }, data: { schoolYearId: null } });
    await tx.schoolYear.delete({ where: { id } });
  });
}
