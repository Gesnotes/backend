import prisma from '../lib/prisma';
import { badRequest, conflict, notFound } from '../errors/AppError';

/**
 * Catégories de notes (interrogation, devoir, composition — et toute
 * catégorie ajoutée par l'école, par exemple deux devoirs de même poids) et
 * leur poids.
 *
 * `POST /grades` exige un `gradeTypeId` : sans route pour lister les
 * catégories, un enseignant ne peut pas saisir la moindre note depuis un
 * client. Le poids est exposé parce qu'il explique le calcul des moyennes —
 * c'est le chiffre que les familles contestent.
 *
 * Ce référentiel n'est plus fermé (voir l'ancien commentaire dans
 * staff.service.ts) : l'administration peut désormais créer, modifier et
 * réordonner ses propres catégories. `required` porte la logique métier qui
 * reposait avant sur la comparaison du `code` littéral ("devoir"/
 * "composition") — voir grading/compute.ts. Le bulletin PDF (bulletin/pdf.ts)
 * affiche directement une colonne par type actif, dans l'ordre de `position`
 * — aucun champ dédié n'est nécessaire pour ça.
 */

export interface GradeTypeView {
  id: number;
  code: string;
  label: string;
  weight: number;
  position: number;
  required: boolean;
  archivedAt: string | null;
  /** Ce qu'une suppression définitive emporterait — affiché dans les archives. */
  gradeCount: number;
  evaluationCount: number;
}

type GradeTypeRow = {
  id: number;
  code: string;
  label: string;
  weight: unknown;
  position: number;
  required: boolean;
  archivedAt: Date | null;
  _count: { grades: number; evaluations: number };
};

const gradeTypeSelect = {
  id: true,
  code: true,
  label: true,
  weight: true,
  position: true,
  required: true,
  archivedAt: true,
  _count: { select: { grades: true, evaluations: true } },
} as const;

function toView(gradeType: GradeTypeRow): GradeTypeView {
  return {
    id: gradeType.id,
    code: gradeType.code,
    label: gradeType.label,
    // `weight` est un Decimal Prisma : sérialisé tel quel, il partirait en
    // chaîne ("2") alors que le reste de l'API expose des nombres.
    weight: Number(gradeType.weight),
    position: gradeType.position,
    required: gradeType.required,
    archivedAt: gradeType.archivedAt ? gradeType.archivedAt.toISOString() : null,
    gradeCount: gradeType._count.grades,
    evaluationCount: gradeType._count.evaluations,
  };
}

/** Même technique que `bulletin.service.ts::slugify`, pour un identifiant stable dérivé du libellé. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    // Plage des diacritiques combinants, échappée : écrite en clair, elle
    // serait invisible dans le source et un simple changement d'encodage la
    // corromprait sans qu'aucun test ne le voie.
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Dérive un `code` unique dans l'école à partir du libellé — un identifiant
 * technique stable, plus jamais comparé en dur par la logique métier (voir
 * l'en-tête du fichier), mais qui doit rester unique pour la contrainte
 * `@@unique([schoolId, code])`.
 */
async function uniqueCode(schoolId: number, label: string, excludeId?: number): Promise<string> {
  const base = slugify(label) || 'type';
  let candidate = base;
  let suffix = 2;

  for (;;) {
    const existing = await prisma.gradeType.findFirst({
      where: { schoolId, code: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

export async function listGradeTypes(
  schoolId: number,
  includeArchived = false,
): Promise<GradeTypeView[]> {
  const gradeTypes = await prisma.gradeType.findMany({
    where: { schoolId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: gradeTypeSelect,
  });

  return gradeTypes.map(toView);
}

export async function getGradeType(schoolId: number, id: number): Promise<GradeTypeView> {
  const gradeType = await prisma.gradeType.findFirst({
    where: { id, schoolId },
    select: gradeTypeSelect,
  });
  if (!gradeType) throw notFound('Type de note introuvable');

  return toView(gradeType);
}

export interface GradeTypeInput {
  label: string;
  weight: number;
  required: boolean;
}

function assertWeight(weight: number) {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw badRequest('Le poids doit être un nombre strictement positif.');
  }
}

export async function createGradeType(schoolId: number, data: GradeTypeInput): Promise<GradeTypeView> {
  assertWeight(data.weight);

  const code = await uniqueCode(schoolId, data.label);
  const last = await prisma.gradeType.findFirst({
    where: { schoolId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  const gradeType = await prisma.gradeType.create({
    data: {
      schoolId,
      code,
      label: data.label,
      weight: data.weight,
      required: data.required,
      position: (last?.position ?? 0) + 1,
    },
    select: gradeTypeSelect,
  });

  return toView(gradeType);
}

export async function updateGradeType(
  schoolId: number,
  id: number,
  data: Partial<GradeTypeInput> & { position?: number },
): Promise<GradeTypeView> {
  await getGradeType(schoolId, id);
  if (data.weight !== undefined) assertWeight(data.weight);

  const gradeType = await prisma.gradeType.update({
    where: { id },
    data: {
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.weight !== undefined ? { weight: data.weight } : {}),
      ...(data.required !== undefined ? { required: data.required } : {}),
      ...(data.position !== undefined ? { position: data.position } : {}),
    },
    select: gradeTypeSelect,
  });

  return toView(gradeType);
}

/**
 * Archivage : toujours autorisé, même sur un type déjà utilisé — comme pour
 * les périodes (`term.service.ts::archiveTerm`). Sort le type des sélecteurs
 * de saisie sans rien perdre de l'historique déjà noté avec.
 */
export async function archiveGradeType(schoolId: number, id: number): Promise<GradeTypeView> {
  await getGradeType(schoolId, id);

  const gradeType = await prisma.gradeType.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: gradeTypeSelect,
  });

  return toView(gradeType);
}

export async function restoreGradeType(schoolId: number, id: number): Promise<GradeTypeView> {
  await getGradeType(schoolId, id);

  const gradeType = await prisma.gradeType.update({
    where: { id },
    data: { archivedAt: null },
    select: gradeTypeSelect,
  });

  return toView(gradeType);
}

/**
 * Suppression définitive — diverge volontairement du pattern période/année
 * scolaire, qui cascadent toujours sur leurs notes et évaluations : un type
 * de note utilisé doit bloquer sa suppression définitive, jamais entraîner
 * ses notes avec lui (les FK `grades.grade_type_id` / `evaluations.grade_type_id`
 * sont d'ailleurs restées en RESTRICT, voir la migration de ce champ). La
 * vérification explicite ici donne un message précis plutôt que de laisser
 * remonter le 409 générique de `errorHandler.ts` sur la contrainte RESTRICT.
 */
export async function deleteGradeTypePermanently(
  schoolId: number,
  id: number,
  expectedLabel: string,
): Promise<void> {
  const gradeType = await getGradeType(schoolId, id);

  if (!gradeType.archivedAt) {
    throw conflict('Archivez ce type de note avant de le supprimer définitivement.', {
      gradeTypeId: id,
    });
  }

  if (expectedLabel.trim().toLowerCase() !== gradeType.label.trim().toLowerCase()) {
    throw badRequest(
      'La confirmation ne correspond pas au libellé du type de note. Cette suppression est définitive.',
      { attendu: gradeType.label },
    );
  }

  if (gradeType.gradeCount > 0 || gradeType.evaluationCount > 0) {
    throw conflict(
      'Ce type de note est utilisé par des notes existantes : il ne peut pas être supprimé définitivement.',
      { gradeTypeId: id, gradeCount: gradeType.gradeCount, evaluationCount: gradeType.evaluationCount },
    );
  }

  await prisma.gradeType.delete({ where: { id } });
}
