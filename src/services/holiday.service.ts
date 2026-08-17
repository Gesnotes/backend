import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';

/**
 * Jours fériés et de congé de l'école.
 *
 * Servent uniquement à exclure « aucun appel » du tableau de bord un jour où
 * aucun appel n'est attendu (voir `dashboard.service.ts::getAttendanceSummary`)
 * — aucune autre table ne les référence.
 */

export interface HolidayView {
  id: number;
  date: string;
  label: string;
  archivedAt: string | null;
}

const holidaySelect = {
  id: true,
  date: true,
  label: true,
  archivedAt: true,
} as const;

type HolidayRow = {
  id: number;
  date: Date;
  label: string;
  archivedAt: Date | null;
};

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toView(holiday: HolidayRow): HolidayView {
  return {
    id: holiday.id,
    date: toIsoDay(holiday.date),
    label: holiday.label,
    archivedAt: holiday.archivedAt ? holiday.archivedAt.toISOString() : null,
  };
}

/**
 * Jours fériés de l'école, du plus ancien au plus récent.
 *
 * Les archivés sont exclus par défaut : seul l'écran des archives demande
 * `includeArchived`, comme pour les périodes.
 */
export async function listHolidays(schoolId: number, includeArchived = false): Promise<HolidayView[]> {
  const holidays = await prisma.holiday.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    select: holidaySelect,
  });

  return holidays.map(toView);
}

export async function getHoliday(schoolId: number, id: number): Promise<HolidayView> {
  const holiday = await prisma.holiday.findFirst({ where: { id, schoolId }, select: holidaySelect });
  if (!holiday) throw notFound('Jour férié introuvable');

  return toView(holiday);
}

export interface HolidayInput {
  date: string;
  label: string;
}

/**
 * Deux jours fériés à la même date, dans la même école, ne rendraient service
 * à personne : autant refuser le doublon plutôt que laisser l'administration
 * en créer deux par mégarde. Les jours archivés sont ignorés — comme pour les
 * périodes, un doublon archivé ne doit pas bloquer sa recréation.
 */
async function assertNoDuplicateDate(schoolId: number, date: string, excludeId?: number) {
  const existing = await prisma.holiday.findFirst({
    where: {
      schoolId,
      archivedAt: null,
      date: new Date(date),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, label: true },
  });

  if (existing) {
    throw conflict(`Un jour férié existe déjà à cette date : « ${existing.label} ».`, {
      holidayId: existing.id,
    });
  }
}

export async function createHoliday(schoolId: number, data: HolidayInput): Promise<HolidayView> {
  await assertNoDuplicateDate(schoolId, data.date);

  const holiday = await prisma.holiday.create({
    data: { schoolId, date: new Date(data.date), label: data.label },
    select: holidaySelect,
  });

  return toView(holiday);
}

export async function updateHoliday(
  schoolId: number,
  id: number,
  data: Partial<HolidayInput>,
): Promise<HolidayView> {
  await getHoliday(schoolId, id);

  if (data.date !== undefined) await assertNoDuplicateDate(schoolId, data.date, id);

  const holiday = await prisma.holiday.update({
    where: { id },
    data: {
      ...(data.date !== undefined ? { date: new Date(data.date) } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
    },
    select: holidaySelect,
  });

  return toView(holiday);
}

/**
 * Archivage : comportement par défaut de la suppression, comme pour les
 * périodes et les années scolaires — un jour férié créé par erreur reste
 * restaurable plutôt que perdu au premier clic.
 */
export async function archiveHoliday(schoolId: number, id: number): Promise<HolidayView> {
  await getHoliday(schoolId, id);

  const holiday = await prisma.holiday.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: holidaySelect,
  });

  return toView(holiday);
}

export async function restoreHoliday(schoolId: number, id: number): Promise<HolidayView> {
  const existing = await getHoliday(schoolId, id);
  await assertNoDuplicateDate(schoolId, existing.date, id);

  const holiday = await prisma.holiday.update({
    where: { id },
    data: { archivedAt: null },
    select: holidaySelect,
  });

  return toView(holiday);
}

/**
 * Suppression définitive, réservée aux jours déjà archivés. Rien n'en dépend
 * en base, mais le libellé exact est tout de même exigé — même garde-fou que
 * pour les autres entités supprimables de l'application, contre le clic sur
 * la mauvaise ligne.
 */
export async function deleteHolidayPermanently(
  schoolId: number,
  id: number,
  expectedLabel: string,
): Promise<void> {
  const holiday = await getHoliday(schoolId, id);

  if (!holiday.archivedAt) {
    throw conflict('Archivez le jour férié avant de le supprimer définitivement.', {
      holidayId: id,
    });
  }

  if (expectedLabel.trim().toLowerCase() !== holiday.label.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au libellé du jour férié. Cette suppression est définitive.',
      { attendu: holiday.label },
    );
  }

  await prisma.holiday.delete({ where: { id } });
}
