import { Prisma } from '../../generated/prisma/client';

const Decimal = Prisma.Decimal;
type D = Prisma.Decimal;

/**
 * Calcul des moyennes — logique pure, sans accès base.
 *
 * Tout est en Decimal de bout en bout : arrondir en cours de route ferait
 * dériver le résultat, et le type `number` de JavaScript introduirait des
 * erreurs de virgule flottante sur des notes que des parents relisent.
 * L'arrondi n'a lieu qu'à la sérialisation (`serializeAverage`).
 */

/** Une note, réduite à ce dont le calcul a besoin. */
export interface GradeInput {
  gradeTypeId: number;
  /** Poids de la catégorie : interrogation 1, devoir 2, composition 3 par défaut. */
  weight: D;
  value: D;
  maxValue: D;
}

export interface SubjectAverageInput {
  average: D;
  coefficient: D;
}

const ZERO = new Decimal(0);
const TWENTY = new Decimal(20);

/**
 * Ramène une note sur 20, quelle que soit sa valeur maximale.
 *
 * Une note sur 10 et une note sur 20 ne peuvent pas être moyennées telles
 * quelles : sans normalisation, 8/10 pèserait comme 8/20.
 */
export function normalizeToTwenty(value: D, maxValue: D): D {
  if (maxValue.lessThanOrEqualTo(0)) {
    throw new Error('maxValue doit être strictement positive');
  }
  return value.div(maxValue).mul(TWENTY);
}

/** Moyenne arithmétique simple. `null` sur une liste vide, jamais 0. */
export function averageOf(values: D[]): D | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum.add(v), ZERO).div(values.length);
}

/**
 * Moyenne d'une matière (plan §2.1).
 *
 *     M_interro + 2 × M_devoir + 3 × M_composition
 *     ────────────────────────────────────────────
 *        somme des poids des catégories NOTÉES
 *
 * Deux étapes : chaque catégorie donne d'abord sa moyenne interne (plusieurs
 * interrogations, plusieurs devoirs), puis les catégories sont pondérées.
 *
 * Choix délibéré de l'établissement (configurable par école, voir
 * `GradeType.required`) : une moyenne n'est publiée que si l'élève a au
 * moins une note de chaque type de note marqué obligatoire — par défaut
 * devoir et composition. Quelques interrogations seules ne suffisent pas à
 * juger un trimestre — les afficher comme moyenne donnerait un chiffre
 * prématuré, avant même le premier vrai devoir noté.
 *
 * `requiredGradeTypeIds` doit porter TOUS les types obligatoires configurés
 * pour l'école, pas seulement ceux déduits de `grades` : un type obligatoire
 * totalement absent des notes de l'élève doit bloquer la moyenne, et
 * `grades` seul ne permet pas de le détecter.
 */
export function subjectAverage(grades: GradeInput[], requiredGradeTypeIds: Set<number>): D | null {
  if (grades.length === 0) return null;

  const gradeTypeIds = new Set(grades.map((g) => g.gradeTypeId));
  for (const requiredId of requiredGradeTypeIds) {
    if (!gradeTypeIds.has(requiredId)) return null;
  }

  const byType = new Map<number, { weight: D; values: D[] }>();

  for (const grade of grades) {
    const normalized = normalizeToTwenty(grade.value, grade.maxValue);
    const entry = byType.get(grade.gradeTypeId) ?? { weight: grade.weight, values: [] };
    entry.values.push(normalized);
    byType.set(grade.gradeTypeId, entry);
  }

  let weightedSum = ZERO;
  let weightTotal = ZERO;

  for (const { weight, values } of byType.values()) {
    const categoryAverage = averageOf(values);
    if (categoryAverage === null) continue;

    weightedSum = weightedSum.add(categoryAverage.mul(weight));
    weightTotal = weightTotal.add(weight);
  }

  // Toutes les catégories notées ont un poids nul : le calcul n'a pas de sens.
  return weightTotal.isZero() ? null : weightedSum.div(weightTotal);
}

/**
 * Moyenne générale (plan §2.1), pondérée par le coefficient de chaque matière.
 *
 * Une matière sans note est exclue — et **son coefficient sort aussi du
 * dénominateur**. La compter 0 pénaliserait un élève pour une matière que le
 * professeur n'a pas encore évaluée.
 */
export function generalAverage(subjects: SubjectAverageInput[]): D | null {
  let weightedSum = ZERO;
  let coefficientTotal = ZERO;

  for (const { average, coefficient } of subjects) {
    weightedSum = weightedSum.add(average.mul(coefficient));
    coefficientTotal = coefficientTotal.add(coefficient);
  }

  return coefficientTotal.isZero() ? null : weightedSum.div(coefficientTotal);
}

/**
 * Arrondi — uniquement ici, à la frontière JSON (plan §2.6).
 * `null` reste `null` : un élève sans note n'est pas un élève à 0.
 */
export function serializeAverage(average: D | null): number | null {
  return average === null ? null : Number(average.toDecimalPlaces(2));
}
