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
  /** Non nul : la période est sortie des sélecteurs, sans rien perdre. */
  archivedAt: string | null;
  /** Ce qu'une suppression définitive emporterait. */
  evaluationCount: number;
  gradeCount: number;
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

type TermRow = {
  id: number;
  label: string;
  startDate: Date | null;
  endDate: Date | null;
  archivedAt: Date | null;
  _count: { evaluations: number; grades: number };
};

/**
 * Les compteurs voyagent avec la période : l'écran des archives doit annoncer
 * ce qu'une suppression définitive détruit, et le faire ligne par ligne coûtait
 * une requête par période.
 */
const termSelect = {
  id: true,
  label: true,
  startDate: true,
  endDate: true,
  archivedAt: true,
  _count: { select: { evaluations: true, grades: true } },
} as const;

function toView(term: TermRow, today: string): TermView {
  return {
    id: term.id,
    label: term.label,
    startDate: term.startDate ? toIsoDay(term.startDate) : null,
    endDate: term.endDate ? toIsoDay(term.endDate) : null,
    // Une période archivée n'est jamais « en cours » : elle ne doit pas être
    // proposée comme sélection par défaut le jour où ses dates couvrent
    // aujourd'hui.
    isCurrent: term.archivedAt === null && isCurrentTerm(term, today),
    archivedAt: term.archivedAt ? term.archivedAt.toISOString() : null,
    evaluationCount: term._count.evaluations,
    gradeCount: term._count.grades,
  };
}

/**
 * Périodes de l'école, de la plus ancienne à la plus récente.
 *
 * Les périodes sans date de début passent en fin de liste : elles ne peuvent
 * pas être situées dans l'année, et les intercaler donnerait un ordre arbitraire.
 *
 * Les archivées sont exclues par défaut : elles ne doivent plus apparaître dans
 * le sélecteur de période, qui est le premier consommateur de cette liste. Seul
 * l'écran des archives demande `includeArchived`.
 */
export async function listTerms(schoolId: number, includeArchived = false): Promise<TermView[]> {
  const terms = await prisma.term.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ startDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    select: termSelect,
  });

  const today = toIsoDay(new Date());
  return terms.map((term) => toView(term, today));
}

export async function getTerm(schoolId: number, id: number): Promise<TermView> {
  const term = await prisma.term.findFirst({ where: { id, schoolId }, select: termSelect });
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
 *
 * Les périodes archivées sont ignorées : elles ne sont plus proposées nulle
 * part, et les garder dans le contrôle rendrait l'archivage inutile — on
 * archive justement une période mal saisie pour pouvoir la refaire aux mêmes
 * dates.
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
      archivedAt: null,
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
    select: termSelect,
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
    select: termSelect,
  });

  return toView(term, toIsoDay(new Date()));
}

/**
 * Archivage : comportement par défaut de la suppression d'une période.
 *
 * `evaluations.term_id` et `grades.term_id` sont en `RESTRICT` — supprimer une
 * période qui a servi échouait en base et remontait au client en 500 illisible.
 * Refuser aurait laissé l'administration sans issue : une période créée par
 * erreur puis utilisée ne pouvait plus disparaître. L'archivage la sort des
 * sélecteurs et des listes sans rien détruire ; la suppression réelle devient
 * une décision distincte, prise depuis les archives.
 */
export async function archiveTerm(schoolId: number, id: number): Promise<TermView> {
  await getTerm(schoolId, id);

  const term = await prisma.term.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: termSelect,
  });

  return toView(term, toIsoDay(new Date()));
}

export async function restoreTerm(schoolId: number, id: number): Promise<TermView> {
  const existing = await getTerm(schoolId, id);

  // Le chevauchement n'est contrôlé qu'entre périodes actives : restaurer une
  // période sur des dates reprises depuis rendrait `isCurrent` ambigu.
  await assertNoOverlap(schoolId, existing.startDate, existing.endDate, id);

  const term = await prisma.term.update({
    where: { id },
    data: { archivedAt: null },
    select: termSelect,
  });

  return toView(term, toIsoDay(new Date()));
}

/**
 * Suppression définitive, en cascade sur les évaluations et les notes.
 *
 * Réservée aux périodes déjà archivées : effacer un trimestre détruit le
 * travail de saisie d'une équipe entière, et rien ne permet de revenir en
 * arrière. Comme pour la suppression d'un élève, le libellé exact doit être
 * retapé — c'est le seul garde-fou contre le clic sur la mauvaise ligne.
 *
 * L'ordre compte : les notes d'abord (elles référencent la période *et* les
 * évaluations), puis les évaluations, puis la période. Le tout dans une
 * transaction, faute de quoi un échec en cours de route laisserait une période
 * à moitié vidée.
 */
export async function deleteTermPermanently(
  schoolId: number,
  id: number,
  expectedLabel: string,
): Promise<void> {
  const term = await getTerm(schoolId, id);

  if (!term.archivedAt) {
    throw conflict(
      'Archivez la période avant de la supprimer définitivement.',
      { termId: id },
    );
  }

  if (expectedLabel.trim().toLowerCase() !== term.label.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au libellé de la période. Cette suppression est définitive.',
      { attendu: term.label },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.grade.deleteMany({ where: { termId: id } });
    await tx.evaluation.deleteMany({ where: { termId: id } });
    await tx.term.delete({ where: { id } });
  });
}
