import { badRequest, conflict } from '../errors/AppError';

/**
 * Garde commune au pattern archiver → restaurer → supprimer définitivement
 * (voir CLAUDE.md, `term.service.ts` comme référence) : une suppression
 * définitive n'est jamais acceptée sur une entité encore active, et exige de
 * retaper son libellé exact — bien plus dur à déclencher par erreur qu'un
 * simple clic de confirmation.
 *
 * Les messages restent au choix de l'appelant : chaque entité les nomme
 * différemment (« la période », « l'année », « ce type de note »), et les
 * généraliser en un seul texte changerait un message déjà en place plutôt
 * que de factoriser la logique.
 */
export function assertPermanentDeleteConfirmed(
  entity: { archivedAt: Date | string | null; label: string },
  expectedLabel: string,
  notArchived: { message: string; details?: Record<string, unknown> },
  labelMismatch: { message: string },
): void {
  if (!entity.archivedAt) {
    throw conflict(notArchived.message, notArchived.details);
  }

  if (expectedLabel.trim().toLowerCase() !== entity.label.trim().toLowerCase()) {
    throw badRequest(labelMismatch.message, { attendu: entity.label });
  }
}
