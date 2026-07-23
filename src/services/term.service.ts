import prisma from '../lib/prisma';
import { notFound } from '../errors/AppError';

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
