import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';

/**
 * Périodes scolaires (trimestres, semestres).
 *
 * Presque toutes les routes de consultation exigent un `term_id` :
 * `/classes/:id`, `/classes/:id/bulletin`, `/children/:id`, `/admin/dashboard`,
 * `/teachers/me/grades`. Sans point d'entrée pour les découvrir, aucun client
 * ne peut construire ces appels — c'est la raison d'être de ce service.
 */

export interface TermView {
  id: number;
  label: string;
  startDate: string | null;
  endDate: string | null;
  /** Période en cours à la date du jour. Au plus une l'est. */
  isCurrent: boolean;
}

/**
 * Une période est « en cours » si la date du jour tombe dans son intervalle.
 *
 * Les bornes sont comparées en jours et non en instants : `start_date` et
 * `end_date` sont des colonnes `DATE`, que Prisma remonte à minuit UTC. Une
 * comparaison directe avec `new Date()` exclurait le dernier jour de la
 * période, qui est justement celui des compositions.
 */
function isCurrentTerm(
  term: { startDate: Date | null; endDate: Date | null },
  today: string,
): boolean {
  if (!term.startDate || !term.endDate) return false;
  const start = toIsoDay(term.startDate);
  const end = toIsoDay(term.endDate);
  return start <= today && today <= end;
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toView(
  term: { id: number; label: string; startDate: Date | null; endDate: Date | null },
  today: string,
): TermView {
  return {
    id: term.id,
    label: term.label,
    startDate: term.startDate ? toIsoDay(term.startDate) : null,
    endDate: term.endDate ? toIsoDay(term.endDate) : null,
    isCurrent: isCurrentTerm(term, today),
  };
}

/**
 * Périodes de l'école, de la plus ancienne à la plus récente.
 *
 * Les périodes sans date de début passent en fin de liste : elles ne peuvent
 * pas être situées dans l'année, et les intercaler donnerait un ordre arbitraire.
 */
export async function listTerms(schoolId: number): Promise<TermView[]> {
  const terms = await prisma.term.findMany({
    where: { schoolId },
    orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: { id: true, label: true, startDate: true, endDate: true },
  });

  const today = toIsoDay(new Date());
  return terms.map((term) => toView(term, today));
}

export async function getTerm(schoolId: number, id: number): Promise<TermView> {
  const term = await prisma.term.findFirst({
    where: { id, schoolId },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  if (!term) throw notFound('Période introuvable');

  return toView(term, toIsoDay(new Date()));
}

export interface TermInput {
  label: string;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Une période bornée doit l'être des deux côtés.
 *
 * Avec une seule borne, `isCurrent` ne peut pas être calculé : la période
 * n'apparaîtrait jamais comme en cours, et le client sélectionnerait une autre
 * période par défaut sans que personne ne comprenne pourquoi.
 */
function assertDateRange(startDate?: string | null, endDate?: string | null) {
  if ((startDate == null) !== (endDate == null)) {
    throw badRequest('Renseignez les deux dates ou aucune');
  }
  if (startDate != null && endDate != null && startDate > endDate) {
    throw badRequest('La date de fin doit suivre la date de début');
  }
}

/**
 * Deux périodes qui se chevauchent rendent `isCurrent` ambigu et faussent la
 * lecture d'un bulletin : une même note tomberait dans deux trimestres.
 */
async function assertNoOverlap(
  schoolId: number,
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  excludeId?: number,
) {
  if (startDate == null || endDate == null) return;

  const overlapping = await prisma.term.findFirst({
    where: {
      schoolId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startDate: { lte: new Date(endDate) },
      endDate: { gte: new Date(startDate) },
    },
    select: { id: true, label: true },
  });

  if (overlapping) {
    throw conflict(`La période « ${overlapping.label} » couvre déjà ces dates`, {
      termId: overlapping.id,
    });
  }
}

export async function createTerm(schoolId: number, data: TermInput): Promise<TermView> {
  assertDateRange(data.startDate, data.endDate);
  await assertNoOverlap(schoolId, data.startDate, data.endDate);

  const term = await prisma.term.create({
    data: {
      schoolId,
      label: data.label,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    },
    select: { id: true, label: true, startDate: true, endDate: true },
  });

  return toView(term, toIsoDay(new Date()));
}

export async function updateTerm(
  schoolId: number,
  id: number,
  data: Partial<TermInput>,
): Promise<TermView> {
  const existing = await prisma.term.findFirst({
    where: { id, schoolId },
    select: { id: true, startDate: true, endDate: true },
  });
  if (!existing) throw notFound('Période introuvable');

  // Les bornes sont validées ensemble, en tenant compte de celles déjà en
  // base : modifier la seule date de fin ne doit pas court-circuiter le
  // contrôle de cohérence.
  const startDate =
    data.startDate !== undefined
      ? data.startDate
      : existing.startDate && toIsoDay(existing.startDate);
  const endDate =
    data.endDate !== undefined ? data.endDate : existing.endDate && toIsoDay(existing.endDate);

  assertDateRange(startDate, endDate);
  await assertNoOverlap(schoolId, startDate, endDate, id);

  const term = await prisma.term.update({
    where: { id },
    data: {
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.startDate !== undefined
        ? { startDate: data.startDate ? new Date(data.startDate) : null }
        : {}),
      ...(data.endDate !== undefined
        ? { endDate: data.endDate ? new Date(data.endDate) : null }
        : {}),
    },
    select: { id: true, label: true, startDate: true, endDate: true },
  });

  return toView(term, toIsoDay(new Date()));
}

/**
 * Suppression refusée dès qu'une note est rattachée.
 *
 * Il n'y a pas d'archivage sur `Term` : la cascade emporterait les notes de
 * tout un trimestre, c'est-à-dire le travail de saisie d'une équipe entière.
 * Renommer la période couvre le cas réel (« Trimestre 1 » créé par erreur).
 */
export async function deleteTerm(schoolId: number, id: number): Promise<void> {
  const term = await prisma.term.findFirst({ where: { id, schoolId }, select: { id: true } });
  if (!term) throw notFound('Période introuvable');

  const gradeCount = await prisma.grade.count({ where: { termId: id } });
  if (gradeCount > 0) {
    throw conflict(
      `Suppression impossible : ${gradeCount} note(s) sont rattachées à cette période.`,
      { gradeCount },
    );
  }

  await prisma.term.delete({ where: { id } });
}
