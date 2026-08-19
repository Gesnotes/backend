import type { Prisma } from '../generated/prisma/client';

/**
 * Nombre d'éléments affichés dans les listes « dernières notes » / « dernières
 * présences » des fiches détail (élève, enseignant) — une seule limite
 * partagée plutôt qu'une constante recopiée dans chaque service.
 */
export const RECENT_GRADES_LIMIT = 10;
export const RECENT_ATTENDANCE_LIMIT = 10;

/**
 * Cœur commun d'une note sérialisée pour l'API : conversion des `Decimal`
 * Prisma en `number`. Partagé entre la fiche élève (qui y ajoute `periode`)
 * et la fiche enseignant (qui y ajoute `eleve`) pour que la conversion —
 * la partie qui affecte réellement l'exactitude des valeurs affichées —
 * ne vive qu'à un seul endroit.
 */
export function serializeGradeAmount(grade: {
  id: number;
  value: Prisma.Decimal;
  maxValue: Prisma.Decimal;
  createdAt: Date | null;
}) {
  return {
    id: grade.id,
    value: Number(grade.value),
    maxValue: Number(grade.maxValue),
    createdAt: grade.createdAt,
  };
}
